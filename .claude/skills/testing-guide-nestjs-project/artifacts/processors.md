> Part of the `testing-guide-nestjs-project` skill (see `../SKILL.md`).

# Queue Processors & Job Schedulers (`*.processor.ts`, BullMQ)

BullMQ via `@nestjs/bullmq` (`phase-03-videos/TD-02`). Processors are `@Processor(queue)` classes that extend `WorkerHost` and implement `process(job)`. They run in the worker entrypoint (`WorkerModule`, `TD-03`), never in the API's `AppModule`. Job schedulers (`queue.upsertJobScheduler`, `TD-16`) produce recurring jobs that a processor consumes.

Infrastructure setup (Redis service, `prefix` isolation, `obliterate`, teardown order) lives in `../references/external-systems.md` → *Message Queue — BullMQ on Redis*. Read it first.

## What to test

- **Job handling logic.** The processor turns `job.data` into the right side effects: DB status transitions, storage writes, metadata persisted.
- **Error classification.** Permanent failures (e.g. no video stream, unreadable container) throw `UnrecoverableError`. Transient failures (network, storage hiccup, crash) throw a plain error so BullMQ retries them (`TD-15`).
- **Retry policy as configured.** The production `attempts` and `backoff` really apply: a transient failure is retried and can succeed later, and an exhausted job ends `failed`.
- **`UnrecoverableError` skips retries.** The job fails after a single attempt despite `attempts > 1`.
- **Terminal-failure hook.** Only the *final* failure sets the terminal state (`processing_status = failed` + `failure_reason`). An attempt that will still be retried must not.
- **Idempotency on retry.** Re-running an attempt after a partial run overwrites or cleans partial outputs rather than duplicating them.
- **Scheduler registration.** The scheduler is upserted with the right id and interval, and registering it twice (two worker boots or replicas) leaves exactly one scheduler.
- **Scheduled handler logic.** The work the scheduled job does (e.g. the stale-upload sweep) is correct, tested **without waiting for the interval**.

## Layer assignment

| Scenario | Unit | Integration | Why |
|---|---|---|---|
| Processor branch logic / error classification | ✅ call `process(job)` with a fake `Job`, mock collaborators | — | Pure decision logic: which error type, which status |
| Retries, backoff, `UnrecoverableError`, `jobId` dedupe | — | ✅ real Redis + real `Worker` | Redis-side BullMQ behaviour; a mocked queue proves nothing |
| Terminal `failed` hook (DB status + reason) | — | ✅ real Redis + real DB | Hook runs on the worker event; the outcome is a DB row |
| Side effects (DB rows, MinIO objects) | — | ✅ real DB + real MinIO | Same rule as services: integration proves the contract |
| Job scheduler registration (id, interval, idempotent upsert) | — | ✅ real Redis | Scheduler state lives in Redis |
| Scheduled handler (e.g. sweep) | ✅ if it branches | ✅ real DB, called **directly** | Test the work, not the clock |
| Module wiring (`registerQueue`, processors in `WorkerModule` only) | ✅ compilation test | — | See `modules.md` |

**Collaborators in integration tests.** To force a transient or permanent failure, override the collaborator at the module boundary, e.g. `overrideProvider(FfmpegService).useValue(stub)`, with a stub that fails N times. This is the same boundary rule as `../references/mock-health-rules.md`. The queue, worker and Redis stay real; only the failure source is scripted.

## Setup pattern — Unit test (error classification)

```typescript
// video.processor.spec.ts
import { UnrecoverableError, Job } from 'bullmq';

describe('VideoProcessor (unit)', () => {
  const ffmpeg = { probe: jest.fn(), transcode: jest.fn(), thumbnail: jest.fn() };
  let processor: VideoProcessor;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        VideoProcessor,
        { provide: FfmpegService, useValue: ffmpeg },
        { provide: VideosService, useValue: { markReady: jest.fn(), markProcessingStep: jest.fn() } },
      ],
    }).compile();
    processor = module.get(VideoProcessor);
  });

  const jobFor = (videoId: string) =>
    ({ id: videoId, data: { videoId }, attemptsMade: 0, opts: { attempts: 3 } }) as unknown as Job<VideoJobData>;

  it('fails fast when the file has no video stream', async () => {
    ffmpeg.probe.mockResolvedValue({ streams: [{ codec_type: 'audio' }], format: { duration: '10' } });

    await expect(processor.process(jobFor('v1'))).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('rethrows transient errors as retryable', async () => {
    ffmpeg.probe.mockRejectedValue(new Error('ECONNRESET'));

    await expect(processor.process(jobFor('v1'))).rejects.not.toBeInstanceOf(UnrecoverableError);
  });
});
```

## Setup pattern — Integration test (retries, `UnrecoverableError`, failed hook)

Build the module as in `external-systems.md` (unique `prefix`, `module.init()` to start the worker, a `QueueEvents` instance), with real DB + MinIO and the failure source overridden:

```typescript
// video.processor.integration-spec.ts
const ffmpegStub = { probe: jest.fn(), transcode: jest.fn(), thumbnail: jest.fn() };

beforeEach(async () => {
  await queue.obliterate({ force: true });
  jest.resetAllMocks();
  // reset DB tables / bucket as usual
});

it('retries a transient failure and succeeds on a later attempt', async () => {
  ffmpegStub.probe
    .mockRejectedValueOnce(new Error('ECONNRESET'))
    .mockResolvedValue(validProbe);
  const video = await seedVideo({ processingStatus: 'processing' });

  const job = await queue.add('process', { videoId: video.id }, { ...PROCESSING_JOB_OPTIONS, jobId: video.id });
  await job.waitUntilFinished(queueEvents);

  expect(ffmpegStub.probe).toHaveBeenCalledTimes(2);
  expect((await findVideo(video.id)).processingStatus).toBe('ready');
});

it('does not retry an UnrecoverableError and marks the video failed with a reason', async () => {
  ffmpegStub.probe.mockResolvedValue({ streams: [], format: {} }); // not a video
  const video = await seedVideo({ processingStatus: 'processing' });

  const job = await queue.add('process', { videoId: video.id }, { ...PROCESSING_JOB_OPTIONS, jobId: video.id });
  await expect(job.waitUntilFinished(queueEvents)).rejects.toThrow();

  expect(ffmpegStub.probe).toHaveBeenCalledTimes(1); // attempts: 3 ignored
  await waitFor(async () => (await findVideo(video.id)).processingStatus === 'failed');
  expect((await findVideo(video.id)).failureReason).toBe('not_a_video');
});

it('marks failed only after the last attempt is exhausted', async () => {
  ffmpegStub.probe.mockRejectedValue(new Error('ECONNRESET'));
  const video = await seedVideo({ processingStatus: 'processing' });

  const job = await queue.add('process', { videoId: video.id }, { ...PROCESSING_JOB_OPTIONS, jobId: video.id });
  await expect(job.waitUntilFinished(queueEvents)).rejects.toThrow();

  expect(ffmpegStub.probe).toHaveBeenCalledTimes(PROCESSING_JOB_OPTIONS.attempts);
  await waitFor(async () => (await findVideo(video.id)).processingStatus === 'failed');
});
```

**Key points:**
- **Use the production job options.** Export them as a constant (e.g. `PROCESSING_JOB_OPTIONS`) and use it in both the producer and the test, so the test asserts the real `attempts`. Make the backoff **delay** configurable (config namespace / env) so the test env can shrink it to a few ms. Never hard-code a different `attempts` in the test.
- **`waitUntilFinished(queueEvents)`** resolves on completion and rejects on *final* failure. Create `QueueEvents` and `await queueEvents.waitUntilReady()` **before** adding the job, or the completion event can be missed.
- **The terminal hook races the assertion.** The `failed` handler (`@OnWorkerEvent('failed')`) runs on the worker *after* the failure is recorded, so `waitUntilFinished` can reject before the DB row is updated. Poll with a small `waitFor(predicate, timeout)` helper in `src/test/` rather than asserting immediately. Never use fixed `sleep`s.
- **Final vs intermediate failure.** Do not assume the worker `failed` event fires only once per job. The hook must check that this was the final attempt (`job.attemptsMade >= (job.opts.attempts ?? 1)` or `err instanceof UnrecoverableError`). The "marks failed only after the last attempt" test protects that guard.
- Close `QueueEvents` and the module in `afterAll` (see `../references/gotchas.md` #3).

## Setup pattern — Job schedulers (`upsertJobScheduler`)

Test **registration** and the **scheduled work** separately. Never wait for the real interval.

```typescript
// stale-upload-sweep.integration-spec.ts
it('registers the sweep scheduler once with the configured interval', async () => {
  await sweepScheduler.register(); // e.g. called from WorkerModule onApplicationBootstrap
  await sweepScheduler.register(); // second boot / second replica

  const schedulers = await maintenanceQueue.getJobSchedulers();
  expect(schedulers).toHaveLength(1);
  const scheduler = await maintenanceQueue.getJobScheduler('stale-upload-sweep');
  expect(scheduler?.every).toBe(60 * 60 * 1000);
});

it('marks only uploads older than 24h and still uploading as failed', async () => {
  const now = new Date('2026-10-10T12:00:00Z');
  const stale = await seedVideo({ processingStatus: 'uploading', createdAt: hoursBefore(now, 25) });
  const fresh = await seedVideo({ processingStatus: 'uploading', createdAt: hoursBefore(now, 1) });
  const done = await seedVideo({ processingStatus: 'processing', createdAt: hoursBefore(now, 25) });

  await sweepService.markStaleUploads(now); // the method the maintenance processor calls

  expect((await findVideo(stale.id)).processingStatus).toBe('failed');
  expect((await findVideo(stale.id)).failureReason).toBe('upload_expired');
  expect((await findVideo(fresh.id)).processingStatus).toBe('uploading');
  expect((await findVideo(done.id)).processingStatus).toBe('processing');
});
```

**Key points:**
- **Inject the clock** (pass `now`, or inject a clock provider) so the age rule is tested deterministically, without fake timers fighting Redis.
- **Do not wait for the scheduled tick.** For a newly created scheduler, the first run is immediate, and later runs only happen once the previous job *starts*. Neither is your code to test. Assert the registration (`getJobScheduler`) and test the handler directly.
- **Remove schedulers between tests.** `queue.obliterate({ force: true })` (in `beforeEach`) removes them; so does `removeJobScheduler(id)`. Otherwise the immediate first run of a leftover scheduler fires during unrelated tests.
- **Race with other writers.** The sweep and the storage-event consumer can both move a video out of `uploading`. Test that the sweep's update is **conditional** (`WHERE processing_status = 'uploading'`): seed a stale row, flip it to `processing` "concurrently" (before calling the sweep), and assert the sweep leaves it alone.

## When to skip

- BullMQ internals: exact backoff timing math, stalled-job detection, lock renewal, scheduler firing at the interval. Trust the library; test *your* options and handlers.
- That `@Processor()` / `@OnWorkerEvent()` bind to the right queue: covered implicitly by the integration tests above and by the `WorkerModule` compilation test.
- Thin processors that only call one service method with no branching: test the service, plus one integration test that a job reaches it.

## Examples from project

Phase 03 (`docs/phases/phase-03-videos/`):
- **VideoProcessor** [`video-processing` queue: FFmpeg probe/transcode/thumbnail + DB + MinIO]
  - Unit: error classification (`UnrecoverableError` for no video stream / unreadable input).
  - Integration: retry-then-succeed, `UnrecoverableError` single attempt, final-attempt-only `failed` hook with `failure_reason`, `ready` with duration/thumbnail persisted.
- **Stale-upload sweep** [`maintenance` queue + job scheduler, `TD-16`]
  - Integration: idempotent `upsertJobScheduler` registration with the configured interval.
  - Integration: `markStaleUploads(now)` against real PostgreSQL, including the conditional-update race.
- **Storage-event consumer → producer** [enqueue with `jobId = videoId`, `TD-06`]
  - Integration: duplicate events produce one job (see `../references/external-systems.md`).
