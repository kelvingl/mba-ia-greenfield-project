import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import {
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { INTERNAL_S3_CLIENT, PUBLIC_S3_CLIENT } from './storage.constants';
import { InvalidUploadPartsError } from './storage.errors';

export interface UploadedPart {
  partNumber: number;
  etag: string;
  size: number;
}

export interface PresignedPart {
  partNumber: number;
  url: string;
}

export interface CompletedPartInput {
  partNumber: number;
  etag: string;
}

export interface PresignGetOptions {
  /** Sets `response-content-disposition`, e.g. `attachment; filename="a.mp4"`. */
  responseContentDisposition?: string;
}

/** Error names S3-compatible servers return when the part list is unacceptable. */
const INVALID_PARTS_ERRORS = new Set([
  'InvalidPart',
  'InvalidPartOrder',
  'EntityTooSmall',
  'NoSuchUpload',
]);

@Injectable()
export class StorageService {
  constructor(
    @Inject(INTERNAL_S3_CLIENT) private readonly internalClient: S3Client,
    @Inject(PUBLIC_S3_CLIENT) private readonly publicClient: S3Client,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {}

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    const { UploadId } = await this.internalClient.send(
      new CreateMultipartUploadCommand({
        Bucket: this.config.bucket,
        Key: key,
        ContentType: contentType,
      }),
    );
    return UploadId as string;
  }

  /** Presigned PUT URLs for the browser, signed against the public endpoint. */
  async presignUploadParts(
    key: string,
    uploadId: string,
    partNumbers: number[],
  ): Promise<PresignedPart[]> {
    return Promise.all(
      partNumbers.map(async (partNumber) => ({
        partNumber,
        url: await getSignedUrl(
          this.publicClient,
          new UploadPartCommand({
            Bucket: this.config.bucket,
            Key: key,
            UploadId: uploadId,
            PartNumber: partNumber,
          }),
          { expiresIn: this.config.partUrlTtlSeconds },
        ),
      })),
    );
  }

  async listParts(key: string, uploadId: string): Promise<UploadedPart[]> {
    const parts: UploadedPart[] = [];
    let marker: string | undefined;
    do {
      const page = await this.internalClient.send(
        new ListPartsCommand({
          Bucket: this.config.bucket,
          Key: key,
          UploadId: uploadId,
          PartNumberMarker: marker,
        }),
      );
      for (const part of page.Parts ?? []) {
        parts.push({
          partNumber: part.PartNumber as number,
          etag: part.ETag as string,
          size: part.Size as number,
        });
      }
      marker = page.IsTruncated ? String(page.NextPartNumberMarker) : undefined;
    } while (marker);
    return parts;
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPartInput[],
  ): Promise<void> {
    try {
      await this.internalClient.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.config.bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: parts.map((part) => ({
              PartNumber: part.partNumber,
              ETag: part.etag,
            })),
          },
        }),
      );
    } catch (error) {
      if (error instanceof Error && INVALID_PARTS_ERRORS.has(error.name)) {
        throw new InvalidUploadPartsError(error.name);
      }
      throw error;
    }
  }

  async headObject(key: string): Promise<{ size: number }> {
    const head = await this.internalClient.send(
      new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }),
    );
    return { size: head.ContentLength as number };
  }

  async deleteObject(key: string): Promise<void> {
    await this.internalClient.send(
      new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }),
    );
  }

  async putObjectFromFile(
    key: string,
    filePath: string,
    contentType: string,
  ): Promise<void> {
    const { size } = await stat(filePath);
    await this.internalClient.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: createReadStream(filePath),
        ContentLength: size,
        ContentType: contentType,
      }),
    );
  }

  /** Short-lived GET URL for the browser (streaming/download). */
  presignGet(key: string, options: PresignGetOptions = {}): Promise<string> {
    return this.signGet(this.publicClient, key, options);
  }

  /** GET URL reachable from inside the Compose network (ffprobe/ffmpeg input). */
  presignInternalGet(key: string): Promise<string> {
    return this.signGet(this.internalClient, key, {});
  }

  /** Permanent URL of an object under the public-read `thumbnails/` prefix. */
  publicObjectUrl(key: string): string {
    return `${this.config.publicEndpoint}/${this.config.bucket}/${key}`;
  }

  private signGet(
    client: S3Client,
    key: string,
    options: PresignGetOptions,
  ): Promise<string> {
    return getSignedUrl(
      client,
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        ResponseContentDisposition: options.responseContentDisposition,
      }),
      { expiresIn: this.config.deliveryUrlTtlSeconds },
    );
  }
}
