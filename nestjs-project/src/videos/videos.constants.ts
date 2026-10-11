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

/** Accepted upload MIME types and the file extension used for the stored object. */
export const VIDEO_MIME_EXTENSIONS = {
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'video/x-matroska': '.mkv',
} as const;

export const ALLOWED_VIDEO_MIME_TYPES = Object.keys(
  VIDEO_MIME_EXTENSIONS,
) as (keyof typeof VIDEO_MIME_EXTENSIONS)[];

/** 10 GiB (phase-03-videos/TD-07 Revision). */
export const MAX_VIDEO_SIZE_BYTES = 10_737_418_240;

/** 64 MiB, dictated by the server so the client never picks a part size. */
export const UPLOAD_PART_SIZE_BYTES = 67_108_864;

export const TITLE_MAX_LENGTH = 100;
export const FILENAME_MAX_LENGTH = 255;
export const DEFAULT_VIDEO_TITLE = 'Untitled video';

export const MAX_PART_URLS_PER_REQUEST = 100;

/** S3 allows at most 10 000 parts; 10 GiB / 64 MiB needs only 160. */
export const MAX_UPLOAD_PARTS = 10_000;

/** A draft still `uploading` after this long is abandoned (TD-07 / TD-16). */
export const STALE_UPLOAD_MAX_AGE_HOURS = 24;
