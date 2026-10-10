import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { SignUploadPartsDto } from './dto/sign-upload-parts.dto';
import { UploadInitResponseDto } from './dto/upload-init-response.dto';
import {
  CompleteUploadResponseDto,
  PartUrlsResponseDto,
  UploadedPartsResponseDto,
} from './dto/upload-responses.dto';
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
  @Post(':publicId/upload/part-urls')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Sign upload part URLs',
    description:
      'Returns presigned PUT URLs for the requested part numbers, valid for one hour. The client uploads each part straight to the object storage and keeps the returned ETag.',
  })
  @ApiParam({ name: 'publicId', description: 'Public id of the video' })
  @ApiResponse({
    status: 200,
    description: 'Presigned part URLs',
    type: PartUrlsResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed or part number outside the upload range',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found (or not owned by the caller)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not accepting uploads',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async signPartUrls(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
    @Body() dto: SignUploadPartsDto,
  ): Promise<PartUrlsResponseDto> {
    const { urls, expiresIn } = await this.videosService.signUploadParts(
      user.sub,
      publicId,
      dto.part_numbers,
    );
    return {
      urls: urls.map(({ partNumber, url }) => ({
        part_number: partNumber,
        url,
      })),
      expires_in: expiresIn,
    };
  }

  @Get(':publicId/upload/parts')
  @ApiOperation({
    summary: 'List uploaded parts',
    description:
      'Lists the parts already stored for an in-progress upload, so an interrupted upload can resume.',
  })
  @ApiParam({ name: 'publicId', description: 'Public id of the video' })
  @ApiResponse({
    status: 200,
    description: 'Upload contract and the parts already stored',
    type: UploadedPartsResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found (or not owned by the caller)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not accepting uploads',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async listParts(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
  ): Promise<UploadedPartsResponseDto> {
    const { partSize, partCount, parts } =
      await this.videosService.listUploadedParts(user.sub, publicId);
    return {
      part_size: partSize,
      part_count: partCount,
      parts: parts.map(({ partNumber, etag, size }) => ({
        part_number: partNumber,
        etag,
        size,
      })),
    };
  }

  @Post(':publicId/upload/complete')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Complete the multipart upload',
    description:
      'Finalizes the multipart upload in the storage. It does not start processing: the storage notifies the API when the object exists, and the video then moves to `processing`.',
  })
  @ApiParam({ name: 'publicId', description: 'Public id of the video' })
  @ApiResponse({
    status: 202,
    description: 'Upload finalized; processing starts asynchronously',
    type: CompleteUploadResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed or the storage rejected the part list',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found (or not owned by the caller)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not accepting uploads',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<CompleteUploadResponseDto> {
    const video = await this.videosService.completeUpload(
      user.sub,
      publicId,
      dto.parts.map(({ part_number, etag }) => ({
        partNumber: part_number,
        etag,
      })),
    );
    return {
      public_id: video.public_id,
      processing_status: video.processing_status,
    };
  }
}
