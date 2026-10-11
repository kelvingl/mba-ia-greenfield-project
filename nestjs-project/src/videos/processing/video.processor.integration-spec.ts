import { HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { readFile } from 'node:fs/promises';
import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { Queue, QueueEvents } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import queueConfig from '../../config/queue.config';
import storageConfig from '../../config/storage.config';
import {
  PROCESS_VIDEO_JOB,
  PROCESSING_MAX_ATTEMPTS,
  processingJobOptions,
  VIDEO_PROCESSING_QUEUE,
} from '../../queue/queue.constants';
import { QueueModule } from '../../queue/queue.module';
import { StorageService } from '../../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import {
  createMediaFixtures,
  MediaFixtures,
  removeMediaFixtures,
} from '../../test/media';
import {
  emptyTestBucket,
  internalS3Client,
  TEST_BUCKET,
  useTestBucket,
} from '../../test/s3';
import { waitFor } from '../../test/wait-for';
import { User } from '../../users/entities/user.entity';
import { Video } from '../entities/video.entity';
import { FAILURE_REASONS, VideoProcessingStatus } from '../videos.constants';
import { VideoProcessingModule } from './video-processing.module';

const BACKOFF_MS = 10;

describe('VideoProcessor (integration, real Redis + Postgres + MinIO + FFmpeg)', () => {
  let module: TestingModule;
  let queue: Queue;
  let queueEvents: QueueEvents;
  let storage: StorageService;
  let videos: Repository<Video>;
  let dataSource: DataSource;
  let fixtures: MediaFixtures;
  let channelId: string;
  const connection = {
    host: process.env.REDIS_HOST ?? 'redis',
    port: Number(process.env.REDIS_PORT ?? 6379),
  };
  const prefix = `test-${Date.now()}-video-processor`;

  /** Seeds a `processing` video whose original is the given file in the bucket. */
  async function seedVideo(file: string, suffix = 'a') {
    const video = await videos.save(
      videos.create({
        channel_id: channelId,
        public_id: `pub${suffix}`.padEnd(11, 'x'),
        title: 'aula',
        original_filename: 'aula.mp4',
        mime_type: 'video/mp4',
        declared_size: 1_000_000,
        size: 1_000_000,
        processing_status: VideoProcessingStatus.PROCESSING,
        original_key: 'pending',
      }),
    );
    const key = `originals/${video.id}/source.mp4`;
    await videos.update({ id: video.id }, { original_key: key });
    await internalS3Client.send(
      new PutObjectCommand({
        Bucket: TEST_BUCKET,
        Key: key,
        Body: await readFile(file),
      }),
    );
    return video.id;
  }

  const enqueue = (videoId: string) =>
    queue.add(
      PROCESS_VIDEO_JOB,
      { videoId },
      { ...processingJobOptions(BACKOFF_MS), jobId: videoId },
    );

  const exists = (key: string) =>
    internalS3Client
      .send(new HeadObjectCommand({ Bucket: TEST_BUCKET, Key: key }))
      .then(() => true)
      .catch(() => false);

  const find = (id: string) => videos.findOneByOrFail({ id });

  beforeAll(async () => {
    useTestBucket();
    process.env.QUEUE_PREFIX = prefix;
    process.env.VIDEO_PROCESSING_BACKOFF_MS = String(BACKOFF_MS);
    fixtures = await createMediaFixtures();

    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(
          createTestDataSource([User, Channel, Video], { synchronize: false })
            .options,
        ),
        QueueModule,
        VideoProcessingModule,
      ],
    }).compile();
    await module.init(); // starts the @Processor worker

    queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    storage = module.get(StorageService);
    dataSource = module.get(DataSource);
    videos = module.get(getRepositoryToken(Video));
    queueEvents = new QueueEvents(VIDEO_PROCESSING_QUEUE, {
      connection,
      prefix,
    });
    await queueEvents.waitUntilReady();
  }, 120_000);

  beforeEach(async () => {
    jest.restoreAllMocks();
    await queue.obliterate({ force: true });
    await cleanAllTables(dataSource);
    await emptyTestBucket();
    const user = await dataSource
      .getRepository(User)
      .save({ email: 'owner@example.com', password: 'hashed' });
    const channel = await dataSource
      .getRepository(Channel)
      .save({ name: 'owner', nickname: 'owner', user_id: user.id });
    channelId = channel.id;
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await queueEvents.close();
    await cleanAllTables(dataSource);
    await emptyTestBucket();
    await removeMediaFixtures(fixtures);
    await module.close();
  });

  it('should take a valid upload to ready with metadata and both outputs', async () => {
    const id = await seedVideo(fixtures.mp4);

    const job = await enqueue(id);
    await job.waitUntilFinished(queueEvents);

    const video = await find(id);
    expect(video.processing_status).toBe(VideoProcessingStatus.READY);
    expect(video.duration_seconds).toBeGreaterThan(1.9);
    expect(video.duration_seconds).toBeLessThan(2.1);
    expect(video.width).toBe(640);
    expect(video.height).toBe(360);
    expect(video.video_codec).toBe('h264');
    expect(video.audio_codec).toBe('aac');
    expect(video.playback_key).toBe(`playback/${id}.mp4`);
    expect(video.thumbnail_key).toBe(`thumbnails/${id}.jpg`);
    expect(await exists(`playback/${id}.mp4`)).toBe(true);
    expect(await exists(`thumbnails/${id}.jpg`)).toBe(true);
    expect(await exists(`originals/${id}/source.mp4`)).toBe(true);
  }, 60_000);

  it('should fail a file that is not a video after a single attempt', async () => {
    const id = await seedVideo(fixtures.garbage);
    const probe = jest.spyOn(module.get(StorageService), 'presignInternalGet');

    const job = await enqueue(id);
    await expect(job.waitUntilFinished(queueEvents)).rejects.toThrow();

    await waitFor(
      async () =>
        (await find(id)).processing_status === VideoProcessingStatus.FAILED,
    );
    expect((await find(id)).failure_reason).toBe(FAILURE_REASONS.NOT_A_VIDEO);
    expect(probe).toHaveBeenCalledTimes(1);
    expect((await queue.getJob(id))?.attemptsMade).toBe(1);
  }, 60_000);

  it('should retry a transient upload failure and still end ready', async () => {
    const id = await seedVideo(fixtures.mp4);
    jest
      .spyOn(storage, 'putObjectFromFile')
      .mockRejectedValueOnce(new Error('ECONNRESET'));
    const statuses: VideoProcessingStatus[] = [];
    const watcher = setInterval(() => {
      void find(id).then((v) => statuses.push(v.processing_status));
    }, 20);

    const job = await enqueue(id);
    await job.waitUntilFinished(queueEvents);
    clearInterval(watcher);

    expect((await find(id)).processing_status).toBe(
      VideoProcessingStatus.READY,
    );
    expect(statuses).not.toContain(VideoProcessingStatus.FAILED);
    expect((await queue.getJob(id))?.attemptsMade).toBe(2);
  }, 60_000);

  it('should keep processing while attempts remain and fail only after the last', async () => {
    const id = await seedVideo(fixtures.mp4);
    const failing = jest
      .spyOn(storage, 'putObjectFromFile')
      .mockRejectedValue(new Error('ECONNRESET'));
    const statuses: VideoProcessingStatus[] = [];
    const watcher = setInterval(() => {
      void find(id).then((v) => statuses.push(v.processing_status));
    }, 20);

    const job = await enqueue(id);
    await expect(job.waitUntilFinished(queueEvents)).rejects.toThrow();
    await waitFor(
      async () =>
        (await find(id)).processing_status === VideoProcessingStatus.FAILED,
    );
    clearInterval(watcher);

    expect((await find(id)).failure_reason).toBe(
      FAILURE_REASONS.PROCESSING_FAILED,
    );
    // Every attempt uploads the thumbnail first, which is the call that fails.
    expect(failing).toHaveBeenCalledTimes(PROCESSING_MAX_ATTEMPTS);
    // `failed` was only seen once the last attempt had been spent.
    expect(
      statuses.filter((s) => s === VideoProcessingStatus.PROCESSING).length,
    ).toBeGreaterThan(0);
    expect((await queue.getJob(id))?.attemptsMade).toBe(
      PROCESSING_MAX_ATTEMPTS,
    );
  }, 60_000);

  it('should leave a ready video and its objects untouched when the job runs again', async () => {
    const id = await seedVideo(fixtures.mp4);
    await (await enqueue(id)).waitUntilFinished(queueEvents);
    const before = await find(id);
    const put = jest.spyOn(storage, 'putObjectFromFile');
    await queue.obliterate({ force: true });

    await (await enqueue(id)).waitUntilFinished(queueEvents);

    const after = await find(id);
    expect(after.updated_at).toEqual(before.updated_at);
    expect(after.processing_status).toBe(VideoProcessingStatus.READY);
    expect(put).not.toHaveBeenCalled();
  }, 60_000);
});
