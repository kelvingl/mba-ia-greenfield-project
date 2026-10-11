import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import queueConfig from '../config/queue.config';
import { MAINTENANCE_QUEUE, VIDEO_PROCESSING_QUEUE } from './queue.constants';

/**
 * BullMQ connection and queue registration. Importing this module only makes
 * the queues available to produce jobs; consumers (`@Processor`) are
 * registered exclusively in `WorkerModule`.
 */
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [queueConfig.KEY],
      useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
        connection: { host: cfg.redisHost, port: cfg.redisPort },
        prefix: cfg.prefix,
      }),
    }),
    BullModule.registerQueue(
      { name: VIDEO_PROCESSING_QUEUE },
      { name: MAINTENANCE_QUEUE },
    ),
  ],
  exports: [BullModule],
})
export class QueueModule {}
