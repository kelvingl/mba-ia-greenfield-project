import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Video } from '../entities/video.entity';
import {
  FAILURE_REASONS,
  STALE_UPLOAD_MAX_AGE_HOURS,
  VideoProcessingStatus,
} from '../videos.constants';

const HOUR_MS = 60 * 60 * 1000;

/**
 * Gives abandoned uploads a terminal state so no video stays `uploading`
 * forever (phase-03-videos/TD-16). The storage drops the orphaned multipart
 * parts on its own after the same period.
 */
@Injectable()
export class StaleUploadSweepService {
  constructor(
    @InjectRepository(Video) private readonly videos: Repository<Video>,
  ) {}

  /**
   * Fails every draft still `uploading` and older than 24 h; returns how many.
   * The status condition lives in the UPDATE itself: the storage event consumer
   * may be moving the same row to `processing` at this very moment.
   */
  async markStaleUploads(now: Date): Promise<number> {
    const cutoff = new Date(
      now.getTime() - STALE_UPLOAD_MAX_AGE_HOURS * HOUR_MS,
    );
    const result = await this.videos
      .createQueryBuilder()
      .update(Video)
      .set({
        processing_status: VideoProcessingStatus.FAILED,
        failure_reason: FAILURE_REASONS.UPLOAD_EXPIRED,
        upload_id: null,
      })
      .where('processing_status = :status', {
        status: VideoProcessingStatus.UPLOADING,
      })
      .andWhere('created_at < :cutoff', { cutoff })
      .execute();
    return result.affected ?? 0;
  }
}
