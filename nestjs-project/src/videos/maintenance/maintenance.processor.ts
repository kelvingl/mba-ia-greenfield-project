import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import {
  MAINTENANCE_QUEUE,
  SWEEP_STALE_UPLOADS_JOB,
} from '../../queue/queue.constants';
import { StaleUploadSweepService } from './stale-upload-sweep.service';

/** Consumer of the `maintenance` queue; registered only in the worker. */
@Processor(MAINTENANCE_QUEUE)
export class MaintenanceProcessor extends WorkerHost {
  private readonly logger = new Logger(MaintenanceProcessor.name);

  constructor(private readonly sweep: StaleUploadSweepService) {
    super();
  }

  async process(job: Job): Promise<void> {
    if (job.name !== SWEEP_STALE_UPLOADS_JOB) {
      this.logger.warn(`Ignoring unknown maintenance job: ${job.name}`);
      return;
    }
    const expired = await this.sweep.markStaleUploads(new Date());
    if (expired > 0) this.logger.log(`Expired ${expired} stale upload(s)`);
  }
}
