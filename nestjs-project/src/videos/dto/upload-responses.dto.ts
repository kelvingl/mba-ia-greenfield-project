import { VideoProcessingStatus } from '../videos.constants';

export class PartUrlDto {
  part_number: number;

  /** Presigned URL to PUT the part bytes to, straight on the object storage. */
  url: string;
}

export class PartUrlsResponseDto {
  urls: PartUrlDto[];

  /** Seconds until the URLs expire. */
  expires_in: number;
}

export class UploadedPartDto {
  part_number: number;

  etag: string;

  /** Part size in bytes. */
  size: number;
}

export class UploadedPartsResponseDto {
  part_size: number;

  part_count: number;

  parts: UploadedPartDto[];
}

export class CompleteUploadResponseDto {
  public_id: string;

  /** Stays `uploading`: the storage event moves the video to `processing`. */
  processing_status: VideoProcessingStatus;
}
