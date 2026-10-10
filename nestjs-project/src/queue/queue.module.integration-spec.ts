import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import {
  MAINTENANCE_QUEUE,
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
} from './queue.constants';
import { QueueModule } from './queue.module';

describe('QueueModule (integration, real Redis)', () => {
  let module: TestingModule;
  let videoQueue: Queue;

  beforeAll(async () => {
    process.env.QUEUE_PREFIX = `test-${Date.now()}-queue-module`;
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
      ],
    }).compile();
    videoQueue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
  });

  afterAll(async () => {
    await videoQueue.obliterate({ force: true });
    await module.close();
  });

  it('should register both queues', () => {
    expect(videoQueue).toBeDefined();
    expect(module.get(getQueueToken(MAINTENANCE_QUEUE))).toBeDefined();
  });

  it('should not create a second job when the jobId is repeated', async () => {
    await videoQueue.add(PROCESS_VIDEO_JOB, { videoId: 'v1' }, { jobId: 'v1' });
    await videoQueue.add(PROCESS_VIDEO_JOB, { videoId: 'v1' }, { jobId: 'v1' });

    expect(await videoQueue.getWaitingCount()).toBe(1);
    expect((await videoQueue.getJob('v1'))?.data).toEqual({ videoId: 'v1' });
  });
});
