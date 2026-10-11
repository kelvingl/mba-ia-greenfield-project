import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../../auth/decorators/public.decorator';
import { parseObjectCreatedRecords } from './storage-event';
import { StorageEventsService } from './storage-events.service';
import { StorageWebhookTokenGuard } from './storage-webhook-token.guard';

/**
 * Internal webhook fed by the bucket notification. It is outside the JWT guard
 * (the caller is the storage, not a user) and protected by a shared token; it
 * is not part of the public API contract, hence excluded from OpenAPI.
 */
@Public()
@SkipThrottle()
@ApiExcludeController()
@UseGuards(StorageWebhookTokenGuard)
@Controller('internal/storage-events')
export class StorageEventsController {
  constructor(private readonly events: StorageEventsService) {}

  // The body is an S3 notification, not a DTO: it carries many fields we do not
  // own, which the global whitelist validation would reject.
  @Post()
  @HttpCode(HttpStatus.NO_CONTENT)
  async receive(@Body() body: unknown): Promise<void> {
    for (const record of parseObjectCreatedRecords(body)) {
      await this.events.handleObjectCreated(record);
    }
  }
}
