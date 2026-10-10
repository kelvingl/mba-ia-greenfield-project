import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChannelsModule } from '../channels/channels.module';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { Video } from './entities/video.entity';
import { StorageEventsController } from './storage-events/storage-events.controller';
import { StorageEventsService } from './storage-events/storage-events.service';
import { StorageWebhookTokenGuard } from './storage-events/storage-webhook-token.guard';
import { VideosController } from './videos.controller';
import { VideosService } from './videos.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    StorageModule,
    ChannelsModule,
    QueueModule,
  ],
  controllers: [VideosController, StorageEventsController],
  providers: [VideosService, StorageEventsService, StorageWebhookTokenGuard],
  exports: [TypeOrmModule],
})
export class VideosModule {}
