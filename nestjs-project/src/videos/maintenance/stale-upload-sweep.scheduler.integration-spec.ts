import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { Queue } from 'bullmq';
import queueConfig from '../../config/queue.config';
import {
  MAINTENANCE_QUEUE,
  STALE_UPLOAD_SWEEP_EVERY_MS,
  STALE_UPLOAD_SWEEP_SCHEDULER_ID,
  SWEEP_STALE_UPLOADS_JOB,
} from '../../queue/queue.constants';
import { QueueModule } from '../../queue/queue.module';
import { StaleUploadSweepScheduler } from './stale-upload-sweep.scheduler';

describe('StaleUploadSweepScheduler (integration, real Redis)', () => {
  let module: TestingModule;
  let queue: Queue;
  let scheduler: StaleUploadSweepScheduler;

  beforeAll(async () => {
    process.env.QUEUE_PREFIX = `test-${Date.now()}-sweep-scheduler`;
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
      ],
      // No @Processor here: the scheduled job is only registered, never run.
      providers: [StaleUploadSweepScheduler],
    }).compile();
    queue = module.get<Queue>(getQueueToken(MAINTENANCE_QUEUE));
    scheduler = module.get(StaleUploadSweepScheduler);
  });

  beforeEach(async () => {
    await queue.obliterate({ force: true });
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await module.close();
  });

  it('should leave exactly one hourly scheduler after registering twice', async () => {
    await scheduler.register();
    await scheduler.register(); // second worker boot / second replica

    const schedulers = await queue.getJobSchedulers();
    expect(schedulers).toHaveLength(1);
    const registered = await queue.getJobScheduler(
      STALE_UPLOAD_SWEEP_SCHEDULER_ID,
    );
    expect(registered?.every).toBe(STALE_UPLOAD_SWEEP_EVERY_MS);
    expect(registered?.every).toBe(3_600_000);
    expect(registered?.name).toBe(SWEEP_STALE_UPLOADS_JOB);
  });

  it('should register on application bootstrap', async () => {
    await module.init();

    expect(await queue.getJobSchedulers()).toHaveLength(1);
  });
});
