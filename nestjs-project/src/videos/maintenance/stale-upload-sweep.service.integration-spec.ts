import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video } from '../entities/video.entity';
import { FAILURE_REASONS, VideoProcessingStatus } from '../videos.constants';
import { StaleUploadSweepService } from './stale-upload-sweep.service';

const NOW = new Date('2026-10-10T12:00:00Z');
const hoursBefore = (hours: number) =>
  new Date(NOW.getTime() - hours * 60 * 60 * 1000);

describe('StaleUploadSweepService (integration, real Postgres)', () => {
  let module: TestingModule;
  let service: StaleUploadSweepService;
  let videos: Repository<Video>;
  let dataSource: DataSource;
  let channelId: string;
  let counter = 0;

  async function seed(status: VideoProcessingStatus, ageHours: number) {
    counter += 1;
    const video = await videos.save(
      videos.create({
        channel_id: channelId,
        public_id: `sweep${counter}`.padEnd(11, 'x'),
        title: 'aula',
        original_filename: 'aula.mp4',
        mime_type: 'video/mp4',
        declared_size: 1024,
        processing_status: status,
        upload_id:
          status === VideoProcessingStatus.UPLOADING ? 'upload-1' : null,
        original_key: `originals/${counter}/source.mp4`,
      }),
    );
    // created_at is set by the database; move it into the past explicitly.
    await dataSource.query(
      'UPDATE "videos" SET "created_at" = $1 WHERE "id" = $2',
      [hoursBefore(ageHours), video.id],
    );
    return video.id;
  }

  const find = (id: string) => videos.findOneByOrFail({ id });

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        TypeOrmModule.forRoot(
          createTestDataSource([User, Channel, Video], { synchronize: false })
            .options,
        ),
        TypeOrmModule.forFeature([Video, Channel, User]),
      ],
      // Only the data side: the queue, consumer and scheduler are out of scope.
      providers: [StaleUploadSweepService],
    }).compile();
    service = module.get(StaleUploadSweepService);
    dataSource = module.get(DataSource);
    videos = module.get(getRepositoryToken(Video));
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await dataSource
      .getRepository(User)
      .save({ email: 'owner@example.com', password: 'hashed' });
    const channel = await dataSource
      .getRepository(Channel)
      .save({ name: 'owner', nickname: 'owner', user_id: user.id });
    channelId = channel.id;
  });

  afterAll(async () => {
    await cleanAllTables(dataSource);
    await dataSource.destroy();
  });

  it('should fail an upload older than 24 hours with upload_expired', async () => {
    const id = await seed(VideoProcessingStatus.UPLOADING, 25);

    const expired = await service.markStaleUploads(NOW);

    expect(expired).toBe(1);
    const video = await find(id);
    expect(video.processing_status).toBe(VideoProcessingStatus.FAILED);
    expect(video.failure_reason).toBe(FAILURE_REASONS.UPLOAD_EXPIRED);
    expect(video.upload_id).toBeNull();
  });

  it('should leave a recent upload alone', async () => {
    const id = await seed(VideoProcessingStatus.UPLOADING, 1);

    expect(await service.markStaleUploads(NOW)).toBe(0);

    expect((await find(id)).processing_status).toBe(
      VideoProcessingStatus.UPLOADING,
    );
  });

  it.each([
    VideoProcessingStatus.PROCESSING,
    VideoProcessingStatus.READY,
    VideoProcessingStatus.FAILED,
  ])('should not touch an old video that is %s', async (status) => {
    const id = await seed(status, 25);

    expect(await service.markStaleUploads(NOW)).toBe(0);

    const video = await find(id);
    expect(video.processing_status).toBe(status);
    expect(video.failure_reason).toBeNull();
  });

  it('should not undo a video the event consumer already moved to processing', async () => {
    const id = await seed(VideoProcessingStatus.UPLOADING, 25);
    // The storage event wins the race just before the sweep runs.
    await videos.update(
      { id },
      { processing_status: VideoProcessingStatus.PROCESSING },
    );

    expect(await service.markStaleUploads(NOW)).toBe(0);

    expect((await find(id)).processing_status).toBe(
      VideoProcessingStatus.PROCESSING,
    );
  });
});
