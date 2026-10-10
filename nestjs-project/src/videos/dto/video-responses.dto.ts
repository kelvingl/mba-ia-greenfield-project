import { VideoProcessingStatus } from '../videos.constants';

export class VideoResponseDto {
  public_id: string;

  title: string;

  processing_status: VideoProcessingStatus;

  /** Why the video failed; `null` unless it is `failed`. */
  failure_reason: string | null;

  /** Always `null` in this phase: publishing is a later feature. */
  published_at: string | null;

  duration_seconds: number | null;

  width: number | null;

  height: number | null;

  /** Public, cacheable thumbnail URL; `null` until the video is `ready`. */
  thumbnail_url: string | null;

  created_at: string;
}

export class MediaUrlResponseDto {
  /** Presigned GET URL, signed against the public storage endpoint. */
  url: string;

  /** Seconds until the URL expires. */
  expires_in: number;
}
