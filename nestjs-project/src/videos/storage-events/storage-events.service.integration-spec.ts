import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import queueConfig from '../../config/queue.config';
import storageConfig from '../../config/storage.config';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
} from '../../queue/queue.constants';
import { StorageService } from '../../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import {
  emptyTestBucket,
  internalS3Client,
  TEST_BUCKET,
  useTestBucket,
} from '../../test/s3';
import { User } from '../../users/entities/user.entity';
import { CreateVideoDto } from '../dto/create-video.dto';
import { Video } from '../entities/video.entity';
import { FAILURE_REASONS, VideoProcessingStatus } from '../videos.constants';
import { VideosModule } from '../videos.module';
import { VideosService } from '../videos.service';
import { StorageEventsService } from './storage-events.service';

describe('StorageEventsService (integration, real Postgres + MinIO + Redis)', () => {
  let module: TestingModule;
  let events: StorageEventsService;
  let videosService: VideosService;
  let storage: StorageService;
  let dataSource: DataSource;
  let videos: Repository<Video>;
  let queue: Queue;
  let userId: string;

  /** Draft whose original object really exists in the bucket with `bytes`. */
  async function draftWithObject(declaredSize: number, bytes: number) {
    const { video } = await videosService.createDraft(
      userId,
      Object.assign(new CreateVideoDto(), {
        filename: 'aula.mp4',
        size: declaredSize,
        mime_type: 'video/mp4',
      }),
    );
    await internalS3Client.send(
      new PutObjectCommand({
        Bucket: TEST_BUCKET,
        Key: video.original_key,
        Body: Buffer.alloc(bytes, 1),
      }),
    );
    return video;
  }

  const record = (video: Video, size: number) => ({
    // Event notifications carry the key URL-encoded.
    key: encodeURIComponent(video.original_key),
    size,
  });

  beforeAll(async () => {
    useTestBucket();
    process.env.QUEUE_PREFIX = `test-${Date.now()}-storage-events`;
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(
          createTestDataSource(
            [User, Channel, Video, RefreshToken, VerificationToken],
            { synchronize: false },
          ).options,
        ),
        VideosModule,
      ],
    }).compile();
    events = module.get(StorageEventsService, { strict: false });
    videosService = module.get(VideosService);
    storage = module.get(StorageService);
    dataSource = module.get(DataSource);
    videos = module.get(getRepositoryToken(Video));
    queue = module.get(getQueueToken(VIDEO_PROCESSING_QUEUE), {
      strict: false,
    });
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await emptyTestBucket();
    await queue.obliterate({ force: true });
    const user = await dataSource
      .getRepository(User)
      .save({ email: 'owner@example.com', password: 'hashed' });
    await dataSource
      .getRepository(Channel)
      .save({ name: 'owner', nickname: 'owner', user_id: user.id });
    userId = user.id;
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await cleanAllTables(dataSource);
    await module.close();
  });

  it('should move a verified upload to processing and enqueue one job', async () => {
    const video = await draftWithObject(1024, 1024);

    await events.handleObjectCreated(record(video, 1024));

    const row = await videos.findOneByOrFail({ id: video.id });
    expect(row.processing_status).toBe(VideoProcessingStatus.PROCESSING);
    expect(row.size).toBe(1024);
    expect(row.upload_id).toBeNull();
    const job = await queue.getJob(video.id);
    expect(job?.name).toBe(PROCESS_VIDEO_JOB);
    expect(job?.data).toEqual({ videoId: video.id });
    expect(job?.opts.attempts).toBe(3);
    expect(await queue.getWaitingCount()).toBe(1);
  });

  it('should be idempotent when the same event is delivered twice', async () => {
    const video = await draftWithObject(1024, 1024);

    await events.handleObjectCreated(record(video, 1024));
    const afterFirst = await videos.findOneByOrFail({ id: video.id });
    await events.handleObjectCreated(record(video, 1024));

    expect(await queue.getWaitingCount()).toBe(1);
    const afterSecond = await videos.findOneByOrFail({ id: video.id });
    expect(afterSecond.processing_status).toBe(
      VideoProcessingStatus.PROCESSING,
    );
    expect(afterSecond.updated_at).toEqual(afterFirst.updated_at);
  });

  it('should enqueue the missing job when the video is already processing', async () => {
    const video = await draftWithObject(1024, 1024);
    await videos.update(
      { id: video.id },
      { processing_status: VideoProcessingStatus.PROCESSING },
    );

    await events.handleObjectCreated(record(video, 1024));

    expect(await queue.getWaitingCount()).toBe(1);
  });

  it('should delete an object larger than declared and fail the video', async () => {
    const video = await draftWithObject(1024, 2048);

    await events.handleObjectCreated(record(video, 2048));

    const row = await videos.findOneByOrFail({ id: video.id });
    expect(row.processing_status).toBe(VideoProcessingStatus.FAILED);
    expect(row.failure_reason).toBe(FAILURE_REASONS.FILE_TOO_LARGE);
    expect(row.upload_id).toBeNull();
    await expect(storage.headObject(video.original_key)).rejects.toMatchObject({
      name: 'NotFound',
    });
    expect(await queue.getWaitingCount()).toBe(0);
  });

  it.each([VideoProcessingStatus.READY, VideoProcessingStatus.FAILED])(
    'should leave a %s video untouched',
    async (status) => {
      const video = await draftWithObject(1024, 1024);
      await videos.update({ id: video.id }, { processing_status: status });

      await events.handleObjectCreated(record(video, 1024));

      expect(
        (await videos.findOneByOrFail({ id: video.id })).processing_status,
      ).toBe(status);
      expect(await queue.getWaitingCount()).toBe(0);
    },
  );

  it.each([
    [
      'an unknown video',
      'originals%2F11111111-1111-4111-8111-111111111111%2Fsource.mp4',
    ],
    ['a key outside originals/', 'playback%2Fx.mp4'],
  ])('should ignore an event for %s', async (_label, key) => {
    await expect(
      events.handleObjectCreated({ key, size: 1 }),
    ).resolves.toBeUndefined();
    expect(await queue.getWaitingCount()).toBe(0);
  });
});
