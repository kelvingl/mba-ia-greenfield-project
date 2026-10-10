import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import { StorageModule } from '../../storage/storage.module';
import { User } from '../../users/entities/user.entity';
import { Video } from '../entities/video.entity';
import { FfmpegService } from './ffmpeg.service';
import { VideoProcessor } from './video.processor';

/**
 * Queue consumer side of the video pipeline. Imported only by `WorkerModule`:
 * the API process must never consume jobs (phase-03-videos/TD-03).
 */
@Module({
  imports: [TypeOrmModule.forFeature([Video, Channel, User]), StorageModule],
  providers: [FfmpegService, VideoProcessor],
})
export class VideoProcessingModule {}
