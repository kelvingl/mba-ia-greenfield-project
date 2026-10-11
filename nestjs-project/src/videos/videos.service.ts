import { randomUUID } from 'node:crypto';
import { extname, parse } from 'node:path';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { isUniqueViolationOnColumn } from '../common/database/pg-errors';
import {
  ChannelNotFoundException,
  InvalidPartNumberException,
  InvalidUploadPartsException,
  InvalidUploadStateException,
  VideoNotFoundException,
  VideoNotReadyException,
} from '../common/exceptions/domain.exception';
import { originalKey } from '../storage/storage-keys';
import { InvalidUploadPartsError } from '../storage/storage.errors';
import {
  CompletedPartInput,
  StorageService,
  UploadedPart,
} from '../storage/storage.service';
import { attachmentDisposition } from './content-disposition';
import { CreateVideoDto } from './dto/create-video.dto';
import { Video } from './entities/video.entity';
import { generatePublicId } from './public-id';
import {
  DEFAULT_VIDEO_TITLE,
  TITLE_MAX_LENGTH,
  UPLOAD_PART_SIZE_BYTES,
  VIDEO_MIME_EXTENSIONS,
  VideoProcessingStatus,
} from './videos.constants';

const MAX_PUBLIC_ID_ATTEMPTS = 5;

export interface CreatedDraft {
  video: Video;
  partSize: number;
  partCount: number;
}

export interface SignedParts {
  urls: { partNumber: number; url: string }[];
  expiresIn: number;
}

export interface UploadProgress {
  partSize: number;
  partCount: number;
  parts: UploadedPart[];
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video) private readonly videos: Repository<Video>,
    private readonly storage: StorageService,
    private readonly channelsService: ChannelsService,
  ) {}

  /**
   * Pre-registers the video as a draft and opens the S3 multipart upload.
   * The bytes never pass through the API: the client uploads parts straight to
   * the storage using the part size returned here (phase-03-videos/TD-04/05/07).
   */
  async createDraft(
    userId: string,
    dto: CreateVideoDto,
  ): Promise<CreatedDraft> {
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) throw new ChannelNotFoundException();

    const id = randomUUID();
    const key = originalKey(id, VIDEO_MIME_EXTENSIONS[dto.mime_type]);
    const draft = await this.insertDraft({
      id,
      channel_id: channel.id,
      title: dto.title ?? this.titleFromFilename(dto.filename),
      original_filename: dto.filename,
      mime_type: dto.mime_type,
      declared_size: dto.size,
      original_key: key,
    });

    try {
      draft.upload_id = await this.storage.createMultipartUpload(
        key,
        dto.mime_type,
      );
      const video = await this.videos.save(draft);
      return {
        video,
        partSize: UPLOAD_PART_SIZE_BYTES,
        partCount: Math.ceil(dto.size / UPLOAD_PART_SIZE_BYTES),
      };
    } catch (error) {
      // Compensation: do not leave a draft that has no upload behind it.
      await this.videos.delete({ id });
      throw error;
    }
  }

  /** Presigned PUT URLs so the browser uploads parts straight to the storage. */
  async signUploadParts(
    userId: string,
    publicId: string,
    partNumbers: number[],
  ): Promise<SignedParts> {
    const video = await this.findUploadableOrFail(userId, publicId);
    const partCount = this.partCountOf(video);
    if (partNumbers.some((n) => n < 1 || n > partCount)) {
      throw new InvalidPartNumberException();
    }

    const urls = await this.storage.presignUploadParts(
      video.original_key,
      video.upload_id as string,
      partNumbers,
    );
    return { urls, expiresIn: this.storage.partUrlTtlSeconds };
  }

  /** Parts already stored, so an interrupted upload can resume. */
  async listUploadedParts(
    userId: string,
    publicId: string,
  ): Promise<UploadProgress> {
    const video = await this.findUploadableOrFail(userId, publicId);
    const parts = await this.storage.listParts(
      video.original_key,
      video.upload_id as string,
    );
    return {
      partSize: UPLOAD_PART_SIZE_BYTES,
      partCount: this.partCountOf(video),
      parts,
    };
  }

  /**
   * Finalizes the multipart upload in the storage. It deliberately does NOT
   * enqueue processing nor verify the size: both happen when the storage event
   * is consumed (phase-03-videos/TD-04 and TD-06 Revisions). Idempotent: when
   * the object already exists, a repeated call returns the video as-is.
   */
  async completeUpload(
    userId: string,
    publicId: string,
    parts: CompletedPartInput[],
  ): Promise<Video> {
    const video = await this.findUploadableOrFail(userId, publicId);
    try {
      await this.storage.completeMultipartUpload(
        video.original_key,
        video.upload_id as string,
        parts,
      );
    } catch (error) {
      if (error instanceof InvalidUploadPartsError) {
        // A repeated call after the storage already assembled the object
        // (the upload id is gone) is a success, not a client error.
        if (await this.storage.objectExists(video.original_key)) return video;
        throw new InvalidUploadPartsException();
      }
      throw error;
    }
    return video;
  }

  /** A foreign or missing video is indistinguishable: never reveal drafts. */
  async findOwnedOrFail(userId: string, publicId: string): Promise<Video> {
    const video = await this.videos.findOne({
      where: { public_id: publicId, channel: { user_id: userId } },
    });
    if (!video) throw new VideoNotFoundException();
    return video;
  }

  /** The owner's view of a video, for polling its processing status. */
  async getOwnedVideo(
    userId: string,
    publicId: string,
  ): Promise<{ video: Video; thumbnailUrl: string | null }> {
    const video = await this.findOwnedOrFail(userId, publicId);
    const thumbnailUrl =
      video.processing_status === VideoProcessingStatus.READY &&
      video.thumbnail_key
        ? this.storage.publicObjectUrl(video.thumbnail_key)
        : null;
    return { video, thumbnailUrl };
  }

  /** Short-lived URL to stream `playback.mp4` with HTTP Range requests. */
  async getPlaybackUrl(
    userId: string,
    publicId: string,
  ): Promise<{ url: string; expiresIn: number }> {
    const video = await this.findReadyOrFail(userId, publicId);
    return this.signDelivery(video.playback_key as string);
  }

  /** Short-lived URL that downloads the original file as an attachment. */
  async getDownloadUrl(
    userId: string,
    publicId: string,
  ): Promise<{ url: string; expiresIn: number }> {
    const video = await this.findReadyOrFail(userId, publicId);
    return this.signDelivery(video.original_key, {
      responseContentDisposition: attachmentDisposition(
        video.title,
        extname(video.original_key),
      ),
    });
  }

  private async signDelivery(
    key: string,
    options: { responseContentDisposition?: string } = {},
  ): Promise<{ url: string; expiresIn: number }> {
    return {
      url: await this.storage.presignGet(key, options),
      expiresIn: this.storage.deliveryUrlTtlSeconds,
    };
  }

  private async findReadyOrFail(
    userId: string,
    publicId: string,
  ): Promise<Video> {
    const video = await this.findOwnedOrFail(userId, publicId);
    if (
      video.processing_status !== VideoProcessingStatus.READY ||
      !video.playback_key
    ) {
      throw new VideoNotReadyException();
    }
    return video;
  }

  private async findUploadableOrFail(
    userId: string,
    publicId: string,
  ): Promise<Video> {
    const video = await this.findOwnedOrFail(userId, publicId);
    if (
      video.processing_status !== VideoProcessingStatus.UPLOADING ||
      !video.upload_id
    ) {
      throw new InvalidUploadStateException();
    }
    return video;
  }

  private partCountOf(video: Video): number {
    return Math.ceil(video.declared_size / UPLOAD_PART_SIZE_BYTES);
  }

  /**
   * Inserts the draft retrying on a `public_id` collision. A transaction is
   * deliberately not used: a failed INSERT aborts the whole Postgres
   * transaction, so the retry would be impossible.
   */
  private async insertDraft(data: Partial<Video>): Promise<Video> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.videos.save(
          this.videos.create({ ...data, public_id: generatePublicId() }),
        );
      } catch (error) {
        if (
          !isUniqueViolationOnColumn(error, 'public_id') ||
          attempt >= MAX_PUBLIC_ID_ATTEMPTS
        ) {
          throw error;
        }
      }
    }
  }

  private titleFromFilename(filename: string): string {
    const { name } = parse(filename);
    const title = name.trim().slice(0, TITLE_MAX_LENGTH);
    return title.length > 0 && !title.startsWith('.')
      ? title
      : DEFAULT_VIDEO_TITLE;
  }
}
