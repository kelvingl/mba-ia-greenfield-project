import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsInt,
  Min,
} from 'class-validator';
import { MAX_PART_URLS_PER_REQUEST } from '../videos.constants';

export class SignUploadPartsDto {
  /** Part numbers to sign (1-based, unique, at most 100 per request). */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_PART_URLS_PER_REQUEST)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  part_numbers: number[];
}
