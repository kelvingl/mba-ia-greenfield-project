import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { UploadInitResponseDto } from './dto/upload-init-response.dto';
import { VideosService } from './videos.service';

// The upload flow signs many part URLs and is polled for status, so the
// auth-oriented global rate limit (10/min) does not apply here.
@SkipThrottle()
@ApiTags('videos')
@ApiBearerAuth()
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Start a video upload',
    description:
      'Pre-registers the video as a draft in the caller channel and opens a multipart upload. The response carries the server-dictated part size and count; the client then uploads each part directly to the object storage.',
  })
  @ApiResponse({
    status: 201,
    description: 'Draft created and multipart upload started',
    type: UploadInitResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed (size, MIME type, title or filename)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async create(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoDto,
  ): Promise<UploadInitResponseDto> {
    const { video, partSize, partCount } = await this.videosService.createDraft(
      user.sub,
      dto,
    );
    return {
      public_id: video.public_id,
      title: video.title,
      processing_status: video.processing_status,
      upload: { part_size: partSize, part_count: partCount },
    };
  }
}
