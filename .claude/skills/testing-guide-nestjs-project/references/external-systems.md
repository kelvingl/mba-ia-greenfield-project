> Part of the `testing-guide-nestjs-project` skill (see `../SKILL.md`).

# External System Strategies

How each external system is handled in tests. These strategies were confirmed with the team.

---

## PostgreSQL — Real (Docker)

**Strategy:** Real database via the Docker `db` service (already in `compose.yaml`).

**Connection config for tests:**
```typescript
{
  type: 'postgres',
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  username: process.env.DB_USERNAME ?? 'streamtube',
  password: process.env.DB_PASSWORD ?? 'streamtube',
  database: process.env.DB_DATABASE ?? 'streamtube',
  synchronize: true, // auto-create tables in test setup
}
```

**Test isolation:**
- Use `dataSource.query('DELETE FROM "table_name"')` to clean tables between tests
- Do NOT use `repository.delete({})` — throws `Empty criteria(s) are not allowed`
- Alternative: `repository.clear()` (truncates the table)
- For complex foreign key chains, delete in reverse dependency order or use `TRUNCATE ... CASCADE`
- Use `beforeEach` for cleanup to ensure each test starts with a clean state

**Entity setup:**
- Use `synchronize: true` in test DataSource to auto-create tables from entities
- For integration tests, import only the entities needed by the test — not all entities
- For E2E tests, import `AppModule` which includes all entities via their domain modules

---

## Object Storage — MinIO via the S3 API (Real, Docker)

**Strategy:** A real S3-compatible server (MinIO) runs in Docker for development and tests; production is AWS S3. Application code talks **only to the S3 API** through `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` (`phase-03-videos/TD-01`). There is no local-filesystem adapter, because a filesystem cannot serve presigned multipart URLs, CORS, lifecycle rules or bucket notifications, and those are what the upload flow depends on. Do **not** mock `S3Client` or `getSignedUrl`: a mocked client never catches a wrong endpoint, missing `forcePathStyle`, a bad signature or a wrong bucket policy.

**Compose services (in `nestjs-project/compose.yaml`):**
- `minio`: the pinned MinIO image. API on port 9000, console on 9001.
- An init step (e.g. a one-shot `minio/mc` container) that creates the bucket(s) and applies CORS, the lifecycle rule and the public-read thumbnail prefix. Tests rely on this init step having run, exactly as they rely on `db` being healthy.

**Endpoints — internal vs public (`phase-03-videos/TD-11`):**
- Tests run inside the `nestjs-api` container, so the SDK reaches storage at the **Compose service name**: `S3_ENDPOINT=http://minio:9000`. Never use `localhost` (see root `CLAUDE.md` → Docker Networking).
- Browser-facing presigned URLs are signed against `S3_PUBLIC_ENDPOINT` (a host-reachable URL such as `http://localhost:9000`). That host is **not reachable from inside the container**. SigV4 signs the host, so a URL signed for one host does not work against another. In tests:
  - Assert public URLs by **shape**: host equals `S3_PUBLIC_ENDPOINT`, `X-Amz-Expires` matches the configured TTL, and `response-content-disposition` is present for downloads.
  - For a **round trip** (PUT/GET bytes through a presigned URL), sign with the **internal** endpoint and `fetch` it from the test.

**Client config for MinIO:**
```typescript
new S3Client({
  endpoint: process.env.S3_ENDPOINT ?? 'http://minio:9000',
  region: process.env.S3_REGION ?? 'us-east-1',
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? 'minioadmin',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? 'minioadmin',
  },
  forcePathStyle: true, // required for MinIO behind a service name
  requestChecksumCalculation: 'WHEN_REQUIRED', // see "Checksums" below
  responseChecksumValidation: 'WHEN_REQUIRED',
});
```
- **Checksums:** since SDK v3.729 the client sends CRC32 checksums by default. S3-compatible servers may reject them; `DeleteObjects` is the known case. Presigned part URLs can also end up carrying checksum parameters the browser never sends. `WHEN_REQUIRED` restores the pre-3.729 behaviour. Use the **same** setting in the app config and the tests, so the tests exercise the real client config.

**Test isolation:**
- Use a dedicated test bucket (e.g. `S3_BUCKET=streamtube-test` in the test env), never the dev bucket.
- Empty it in `beforeEach`. Page through `ListObjectsV2Command` (use `paginateListObjectsV2`), then delete with `DeleteObjectCommand` per key, or with `DeleteObjectsCommand` in batches of ≤1000.
- Also abort leftover multipart uploads (`ListMultipartUploadsCommand` + `AbortMultipartUploadCommand`). Otherwise a failed multipart test leaks parts into the next one.
- Put these in a shared helper, `src/test/s3.ts`, mirroring `src/test/mailpit.ts`.

**Integration test — upload + presigned round trip + streaming:**
```typescript
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { emptyTestBucket, internalS3Client, TEST_BUCKET } from '../test/s3';

describe('StorageService (integration)', () => {
  beforeEach(async () => {
    await emptyTestBucket();
  });

  it('stores an object and reports its size via HeadObject', async () => {
    await storageService.putObject('originals/v1/source.mp4', Buffer.alloc(1024));

    const head = await internalS3Client.send(
      new HeadObjectCommand({ Bucket: TEST_BUCKET, Key: 'originals/v1/source.mp4' }),
    );
    expect(head.ContentLength).toBe(1024);
  });

  it('serves byte ranges through a presigned GET (streaming contract)', async () => {
    await internalS3Client.send(
      new PutObjectCommand({ Bucket: TEST_BUCKET, Key: 'playback/v1.mp4', Body: Buffer.alloc(4096) }),
    );
    const url = await getSignedUrl(
      internalS3Client,
      new GetObjectCommand({ Bucket: TEST_BUCKET, Key: 'playback/v1.mp4' }),
      { expiresIn: 60 },
    );

    const res = await fetch(url, { headers: { Range: 'bytes=0-1023' } });
    expect(res.status).toBe(206);
    expect(Number(res.headers.get('content-length'))).toBe(1024);
  });

  it('signs browser-facing download URLs against the public endpoint', async () => {
    const url = new URL(await storageService.getDownloadUrl('originals/v1/source.mp4', 'My video.mp4'));

    expect(url.origin).toBe(new URL(process.env.S3_PUBLIC_ENDPOINT!).origin);
    expect(url.searchParams.get('response-content-disposition')).toContain('attachment');
  });
});
```

**Key points:**
- Real MinIO catches endpoint, path-style, signature, CORS and bucket-policy bugs that a mock or a filesystem adapter cannot.
- Multipart flows (`CreateMultipartUpload` → presigned `UploadPart` → `CompleteMultipartUpload` with every part's `ETag`) are integration-tested end to end against MinIO, using small parts. S3's 5 MiB minimum applies to every part except the last, so a 2-part test needs ≥5 MiB in part 1.
- Bucket notifications (`notify_webhook` → `POST /internal/storage-events`) are exercised in **E2E**, because they need the HTTP app listening. In **integration** tests, call the event-consumer service directly with a recorded event payload.

---

## Message Queue — BullMQ on Redis (Real, Docker)

**Strategy:** A real Redis runs in Docker, with BullMQ through `@nestjs/bullmq` (`phase-03-videos/TD-02`). Do **not** mock `Queue` or `Worker`: retries, backoff, `UnrecoverableError`, `jobId` deduplication, stalled-job recovery and job schedulers are Redis-side behaviour. A mock only proves you called a method. The queue is a configured library, so test it like `JwtModule`: real instance, test config.

**Compose service:** `redis` (e.g. `redis:7-alpine`, port 6379). Tests connect with `REDIS_HOST=redis` (the Compose service name, never `localhost`).

**Test isolation:**
- Give each integration spec file its own BullMQ **`prefix`** (e.g. `test-${path.basename(__filename)}`). Keys then never collide with the dev worker or other spec files, and leftovers are easy to spot.
- In `beforeEach`, call `await queue.obliterate({ force: true })`. It removes waiting, delayed, completed and failed jobs **and job schedulers** for that queue. Use `queue.drain(true)` only when you need to keep schedulers.
- Keep integration specs serial (`npm run test:integration` already uses `--runInBand`).

**Teardown (prevents Jest hangs; see `gotchas.md` #3):** close everything that holds a Redis connection, in this order: workers, `QueueEvents`, queues, then the Nest module/app:
```typescript
afterAll(async () => {
  await queueEvents.close();
  await module.close(); // closes @nestjs/bullmq queues and @Processor workers
});
```

**Setup pattern — test module:**
```typescript
const prefix = `test-${path.basename(__filename)}`;

const module = await Test.createTestingModule({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [queueConfig /* + others */] }),
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST ?? 'redis',
        port: Number(process.env.REDIS_PORT ?? 6379),
      },
      prefix,
    }),
    BullModule.registerQueue({ name: 'video-processing' }),
  ],
  providers: [VideoProcessor /* + real or test deps */],
}).compile();
await module.init(); // starts @Processor workers (onApplicationBootstrap)

const queue = module.get<Queue>(getQueueToken('video-processing'));
const queueEvents = new QueueEvents('video-processing', { connection: { host: process.env.REDIS_HOST ?? 'redis' }, prefix });
await queueEvents.waitUntilReady();
```

**Producer test — job enqueued with correct data, deduplicated by `jobId`.** The test module registers the queue but **no `@Processor`**, so jobs stay in `waiting` and can be inspected:
```typescript
it('enqueues one processing job per video, even when the event is delivered twice', async () => {
  await storageEventsService.handleObjectCreated(eventFor('v1'));
  await storageEventsService.handleObjectCreated(eventFor('v1')); // duplicate notification

  const job = await queue.getJob('v1'); // jobId = videoId
  expect(job?.data).toEqual(expect.objectContaining({ videoId: 'v1' }));
  expect(await queue.getWaitingCount()).toBe(1);
});
```

For processor tests (retries, `UnrecoverableError`, the `failed` hook) and job-scheduler tests, see **`../artifacts/processors.md`**.

---

## Email — Mailpit (Real SMTP Capture)

**Strategy:** Mailpit — a local SMTP server that captures all emails for inspection via its API. No emails are actually delivered.

**Setup:**
- Add Mailpit to `compose.yaml`:
```yaml
mailpit:
  image: axllent/mailpit
  ports:
    - "1025:1025"   # SMTP
    - "8025:8025"   # Web UI / API
```

**NestJS configuration:**
```typescript
// In mail module or config
{
  transport: {
    host: process.env.SMTP_HOST ?? 'localhost',
    port: Number(process.env.SMTP_PORT ?? 1025),
  },
}
```

**Integration test:**
```typescript
describe('MailService (integration)', () => {
  beforeEach(async () => {
    // Clear all captured emails via Mailpit API
    await fetch('http://localhost:8025/api/v1/messages', { method: 'DELETE' });
  });

  it('should send confirmation email', async () => {
    await mailService.sendConfirmation('user@test.com', 'token-123');

    // Query Mailpit API for captured emails
    const response = await fetch('http://localhost:8025/api/v1/messages');
    const data = await response.json();

    expect(data.messages).toHaveLength(1);
    expect(data.messages[0].To[0].Address).toBe('user@test.com');
    expect(data.messages[0].Subject).toContain('confirm');
  });
});
```

**Key points:**
- Mailpit captures ALL emails — no mocking, no side effects
- Use Mailpit's REST API (`http://localhost:8025/api/v1/messages`) to inspect sent emails
- Clear captured emails in `beforeEach` to ensure test isolation
- Web UI at `http://localhost:8025` for manual debugging
- Tests the full SMTP transport path — if the SMTP config is wrong, the test fails
