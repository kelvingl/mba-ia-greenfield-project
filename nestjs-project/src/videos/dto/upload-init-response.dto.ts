import { VideoProcessingStatus } from '../videos.constants';

export class UploadContractDto {
  /** Size in bytes of every part except the last (server-owned). */
  part_size: number;

  /** Number of parts the client must upload. */
  part_count: number;
}

export class UploadInitResponseDto {
  /** Short public identifier of the video (11 characters). */
  public_id: string;

  title: string;

  /** Always `uploading` right after pre-registration. */
  processing_status: VideoProcessingStatus;

  upload: UploadContractDto;
}
