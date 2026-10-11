import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { Repository } from 'typeorm';
import queueConfig from '../../config/queue.config';
import {
  PROCESS_VIDEO_JOB,
  processingJobOptions,
  VIDEO_PROCESSING_QUEUE,
} from '../../queue/queue.constants';
import { parseVideoIdFromOriginalKey } from '../../storage/storage-keys';
import { StorageService } from '../../storage/storage.service';
import { Video } from '../entities/video.entity';
import {
  FAILURE_REASONS,
  MAX_VIDEO_SIZE_BYTES,
  VideoProcessingStatus,
} from '../videos.constants';
import type { ObjectCreatedRecord } from './storage-event';

/**
 * Consumes "object created" notifications from the storage. This is the only
 * place that starts processing: a fact recorded by the storage, not a client
 * report (phase-03-videos/TD-06 Revision). Safe to run more than once per event.
 */
@Injectable()
export class StorageEventsService {
  private readonly logger = new Logger(StorageEventsService.name);

  constructor(
    @InjectRepository(Video) private readonly videos: Repository<Video>,
    private readonly storage: StorageService,
    @InjectQueue(VIDEO_PROCESSING_QUEUE) private readonly queue: Queue,
    @Inject(queueConfig.KEY)
    private readonly queueSettings: ConfigType<typeof queueConfig>,
  ) {}

  async handleObjectCreated(record: ObjectCreatedRecord): Promise<void> {
    const videoId = parseVideoIdFromOriginalKey(record.key);
    if (!videoId) {
      this.logger.warn(`Ignoring event for a non-original key: ${record.key}`);
      return;
    }

    const video = await this.videos.findOneBy({ id: videoId });
    if (!video) {
      this.logger.warn(`Ignoring event for an unknown video: ${videoId}`);
      return;
    }

    if (video.processing_status === VideoProcessingStatus.PROCESSING) {
      // A previous delivery may have updated the row and died before
      // enqueueing; the jobId makes this a no-op when the job already exists.
      await this.enqueue(video.id);
      return;
    }
    if (video.processing_status !== VideoProcessingStatus.UPLOADING) return;

    const size = await this.sizeOfOriginal(video);
    if (size === null) return;

    if (size > MAX_VIDEO_SIZE_BYTES || size > video.declared_size) {
      await this.rejectOversize(video);
      return;
    }

    // Conditional update: only one of several concurrent deliveries wins.
    const { affected } = await this.videos.update(
      { id: video.id, processing_status: VideoProcessingStatus.UPLOADING },
      {
        size,
        upload_id: null,
        processing_status: VideoProcessingStatus.PROCESSING,
      },
    );
    if (affected) await this.enqueue(video.id);
  }

  /** The real size comes from the storage; the notified one is only a hint. */
  private async sizeOfOriginal(video: Video): Promise<number | null> {
    try {
      return (await this.storage.headObject(video.original_key)).size;
    } catch (error) {
      if ((error as { name?: string }).name === 'NotFound') {
        this.logger.warn(`Object of video ${video.id} no longer exists`);
        return null;
      }
      throw error;
    }
  }

  private async rejectOversize(video: Video): Promise<void> {
    await this.storage.deleteObject(video.original_key);
    await this.videos.update(
      { id: video.id, processing_status: VideoProcessingStatus.UPLOADING },
      {
        upload_id: null,
        processing_status: VideoProcessingStatus.FAILED,
        failure_reason: FAILURE_REASONS.FILE_TOO_LARGE,
      },
    );
  }

  private async enqueue(videoId: string): Promise<void> {
    await this.queue.add(
      PROCESS_VIDEO_JOB,
      { videoId },
      {
        ...processingJobOptions(this.queueSettings.processingBackoffDelayMs),
        jobId: videoId,
      },
    );
  }
}
