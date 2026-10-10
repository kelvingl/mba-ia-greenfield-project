import { randomUUID } from 'node:crypto';
import { parse } from 'node:path';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { isUniqueViolationOnColumn } from '../common/database/pg-errors';
import { ChannelNotFoundException } from '../common/exceptions/domain.exception';
import { originalKey } from '../storage/storage-keys';
import { StorageService } from '../storage/storage.service';
import { CreateVideoDto } from './dto/create-video.dto';
import { Video } from './entities/video.entity';
import { generatePublicId } from './public-id';
import {
  DEFAULT_VIDEO_TITLE,
  TITLE_MAX_LENGTH,
  UPLOAD_PART_SIZE_BYTES,
  VIDEO_MIME_EXTENSIONS,
} from './videos.constants';

const MAX_PUBLIC_ID_ATTEMPTS = 5;

export interface CreatedDraft {
  video: Video;
  partSize: number;
  partCount: number;
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
