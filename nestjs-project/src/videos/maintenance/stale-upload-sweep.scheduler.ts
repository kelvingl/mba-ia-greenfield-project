import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import type { Queue } from 'bullmq';
import {
  MAINTENANCE_QUEUE,
  STALE_UPLOAD_SWEEP_EVERY_MS,
  STALE_UPLOAD_SWEEP_SCHEDULER_ID,
  SWEEP_STALE_UPLOADS_JOB,
} from '../../queue/queue.constants';

/**
 * Registers the hourly sweep. The scheduler lives in Redis and is keyed by id,
 * so every worker boot or replica upserts the same one (phase-03-videos/TD-16).
 */
@Injectable()
export class StaleUploadSweepScheduler implements OnApplicationBootstrap {
  constructor(@InjectQueue(MAINTENANCE_QUEUE) private readonly queue: Queue) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.register();
  }

  async register(): Promise<void> {
    await this.queue.upsertJobScheduler(
      STALE_UPLOAD_SWEEP_SCHEDULER_ID,
      { every: STALE_UPLOAD_SWEEP_EVERY_MS },
      { name: SWEEP_STALE_UPLOADS_JOB },
    );
  }
}
