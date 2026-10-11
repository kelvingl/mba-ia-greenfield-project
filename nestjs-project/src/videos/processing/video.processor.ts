import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Job, UnrecoverableError } from 'bullmq';
import { Repository } from 'typeorm';
import queueConfig from '../../config/queue.config';
import { VIDEO_PROCESSING_QUEUE } from '../../queue/queue.constants';
import { playbackKey, thumbnailKey } from '../../storage/storage-keys';
import { StorageService } from '../../storage/storage.service';
import { Video } from '../entities/video.entity';
import { FAILURE_REASONS, VideoProcessingStatus } from '../videos.constants';
import { FfmpegService } from './ffmpeg.service';
import { PermanentMediaError } from './media.errors';

export interface ProcessVideoJobData {
  videoId: string;
}

/**
 * Turns an uploaded original into a streamable video: metadata, thumbnail and a
 * faststart MP4. Registered only in the worker (phase-03-videos/TD-03).
 * Transient errors are rethrown so BullMQ retries; permanent ones are
 * `UnrecoverableError`. The terminal state is set by `onFailed` (TD-15).
 */
@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessor.name);

  constructor(
    @InjectRepository(Video) private readonly videos: Repository<Video>,
    private readonly ffmpeg: FfmpegService,
    private readonly storage: StorageService,
    @Inject(queueConfig.KEY)
    private readonly queueSettings: ConfigType<typeof queueConfig>,
  ) {
    super();
  }

  async process(job: Job<ProcessVideoJobData>): Promise<void> {
    const video = await this.videos.findOneBy({ id: job.data.videoId });
    // Re-delivery of a finished (or not yet uploaded) video is a no-op.
    if (video?.processing_status !== VideoProcessingStatus.PROCESSING) return;

    const workDir = await mkdtemp(
      join(this.queueSettings.processingTmpDir, 'video-'),
    );
    try {
      await this.transform(video, workDir);
    } catch (error) {
      if (error instanceof PermanentMediaError) {
        throw new UnrecoverableError(FAILURE_REASONS.NOT_A_VIDEO);
      }
      throw error;
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  private async transform(video: Video, workDir: string): Promise<void> {
    const originalUrl = await this.storage.presignInternalGet(
      video.original_key,
    );
    const probe = await this.ffmpeg.probe(originalUrl);

    const thumbnailPath = join(workDir, 'thumbnail.jpg');
    await this.ffmpeg.extractThumbnail(
      originalUrl,
      probe.durationSeconds,
      thumbnailPath,
    );

    const sourcePath = join(workDir, 'source');
    const playbackPath = join(workDir, 'playback.mp4');
    await this.storage.downloadObjectToFile(video.original_key, sourcePath);
    await this.ffmpeg.normalizeForPlayback(sourcePath, probe, playbackPath);

    // Outputs overwrite whatever a previous attempt left behind.
    await this.storage.putObjectFromFile(
      thumbnailKey(video.id),
      thumbnailPath,
      'image/jpeg',
    );
    await this.storage.putObjectFromFile(
      playbackKey(video.id),
      playbackPath,
      'video/mp4',
    );

    await this.videos.update(
      { id: video.id, processing_status: VideoProcessingStatus.PROCESSING },
      {
        processing_status: VideoProcessingStatus.READY,
        duration_seconds: probe.durationSeconds,
        width: probe.width,
        height: probe.height,
        video_codec: probe.videoCodec,
        audio_codec: probe.audioCodec,
        thumbnail_key: thumbnailKey(video.id),
        playback_key: playbackKey(video.id),
      },
    );
  }

  /**
   * Runs after every failed attempt; only the last one (or a permanent error)
   * ends the video as `failed`.
   */
  @OnWorkerEvent('failed')
  async onFailed(
    job: Job<ProcessVideoJobData> | undefined,
    error: Error,
  ): Promise<void> {
    if (!job) return;
    const permanent = error instanceof UnrecoverableError;
    if (!permanent && job.attemptsMade < (job.opts.attempts ?? 1)) return;

    this.logger.warn(`Video ${job.data.videoId} failed: ${error.message}`);
    await this.videos.update(
      {
        id: job.data.videoId,
        processing_status: VideoProcessingStatus.PROCESSING,
      },
      {
        processing_status: VideoProcessingStatus.FAILED,
        failure_reason: permanent
          ? FAILURE_REASONS.NOT_A_VIDEO
          : FAILURE_REASONS.PROCESSING_FAILED,
      },
    );
  }
}
