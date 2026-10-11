import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  ALLOWED_VIDEO_MIME_TYPES,
  FILENAME_MAX_LENGTH,
  MAX_VIDEO_SIZE_BYTES,
  TITLE_MAX_LENGTH,
} from '../videos.constants';

export class CreateVideoDto {
  /** Original filename of the video being uploaded. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(FILENAME_MAX_LENGTH)
  filename: string;

  /** File size in bytes (up to 10 GiB). */
  @IsInt()
  @Min(1)
  @Max(MAX_VIDEO_SIZE_BYTES)
  size: number;

  /** MIME type of the file. */
  @IsIn(ALLOWED_VIDEO_MIME_TYPES)
  mime_type: (typeof ALLOWED_VIDEO_MIME_TYPES)[number];

  /** Video title; defaults to the filename without extension. */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(TITLE_MAX_LENGTH)
  title?: string;
}
