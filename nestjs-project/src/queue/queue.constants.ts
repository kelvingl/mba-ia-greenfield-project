import type { JobsOptions } from 'bullmq';

export const VIDEO_PROCESSING_QUEUE = 'video-processing';
export const MAINTENANCE_QUEUE = 'maintenance';

export const PROCESS_VIDEO_JOB = 'process-video';
export const SWEEP_STALE_UPLOADS_JOB = 'sweep-stale-uploads';

export const PROCESSING_MAX_ATTEMPTS = 3;

/**
 * Retry policy of the video processing job: bounded attempts with exponential
 * backoff (phase-03-videos/TD-15). The delay is configurable so tests can
 * shrink it to a few milliseconds.
 */
export const processingJobOptions = (
  backoffDelayMs: number,
): Pick<JobsOptions, 'attempts' | 'backoff'> => ({
  attempts: PROCESSING_MAX_ATTEMPTS,
  backoff: { type: 'exponential', delay: backoffDelayMs },
});
