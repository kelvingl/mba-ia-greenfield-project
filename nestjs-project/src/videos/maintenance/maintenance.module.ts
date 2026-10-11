import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import { QueueModule } from '../../queue/queue.module';
import { User } from '../../users/entities/user.entity';
import { Video } from '../entities/video.entity';
import { MaintenanceProcessor } from './maintenance.processor';
import { StaleUploadSweepScheduler } from './stale-upload-sweep.scheduler';
import { StaleUploadSweepService } from './stale-upload-sweep.service';

/** Scheduled housekeeping. Imported only by `WorkerModule`, like every consumer. */
@Module({
  imports: [TypeOrmModule.forFeature([Video, Channel, User]), QueueModule],
  providers: [
    StaleUploadSweepService,
    MaintenanceProcessor,
    StaleUploadSweepScheduler,
  ],
})
export class MaintenanceModule {}
