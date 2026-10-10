/** Processing axis of the video lifecycle (phase-03-videos/TD-05). */
export enum VideoProcessingStatus {
  UPLOADING = 'uploading',
  PROCESSING = 'processing',
  READY = 'ready',
  FAILED = 'failed',
}

export const VIDEO_PROCESSING_STATUS_ENUM = 'video_processing_status';

/** Machine-readable `failure_reason` values persisted with `failed`. */
export const FAILURE_REASONS = {
  UPLOAD_EXPIRED: 'upload_expired',
  FILE_TOO_LARGE: 'file_too_large',
  NOT_A_VIDEO: 'not_a_video',
  PROCESSING_FAILED: 'processing_failed',
} as const;
