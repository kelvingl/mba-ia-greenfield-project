---
libs:
  "@aws-sdk/client-s3":
    version: "^3.1149.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-10-10T13:33:16-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1149.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-10-10T13:33:16-03:00"
  "@aws-sdk/lib-storage":
    version: "^3.1149.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-10-11T00:00:00-03:00"
  "ioredis":
    version: "^5.11.1"
    context7_id: "/redis/ioredis"
    fetched_at: "2026-10-11T00:00:00-03:00"
  "bullmq":
    version: "^6.3.12"
    context7_id: "/websites/bullmq_io"
    fetched_at: "2026-10-10T13:33:16-03:00"
  "@nestjs/bullmq":
    version: "^12.0.0"
    context7_id: "/nestjs/bull"
    fetched_at: "2026-10-10T13:33:16-03:00"
  "fluent-ffmpeg":
    version: "2.1.3"
    context7_id: "/fluent-ffmpeg/node-fluent-ffmpeg"
    fetched_at: "2026-10-10T13:33:16-03:00"
  "@types/fluent-ffmpeg":
    version: "^2.1.28"
    context7_id: "/fluent-ffmpeg/node-fluent-ffmpeg"
    fetched_at: "2026-10-10T13:33:16-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-10T13:32:25-03:00"
---

# Library References — Phase 03 (videos)

These are notes taken from Context7 and npm on 2026-10-10. They cover only what Phase 03's TDs use. None of these packages is installed in `nestjs-project` yet. Install them at the versions pinned above. All of them are compatible with the installed NestJS 11 (`@nestjs/bullmq@12` peer range: `@nestjs/common|core ^10 || ^11 || ^12`, `bullmq ^3–^6`).

### @aws-sdk/client-s3

Used by TD-01 (S3 API only, MinIO in dev/test), TD-04 (multipart control plane), TD-06/TD-07 (`HeadObject` size check, delete oversize objects) and TD-11 (delivery).

- **Client against MinIO / custom endpoint:** `new S3Client({ endpoint, region, credentials, forcePathStyle: true })`. Path-style addressing is required for MinIO behind a Compose service name. Per TD-11, you need **two** clients/configs: an internal endpoint (`S3_ENDPOINT`, Compose service name) for server-side calls, and a public endpoint (`S3_PUBLIC_ENDPOINT`) for **signing** browser-facing URLs. SigV4 signs the host, so a URL signed for the internal host fails in the browser.
- **Multipart (TD-04 A):** `CreateMultipartUpload` → returns `UploadId`. Parts are uploaded by the client through presigned `UploadPartCommand({ Bucket, Key, UploadId, PartNumber })` URLs. `CompleteMultipartUpload({ MultipartUpload: { Parts: [{ ETag, PartNumber }] } })` must list every part with its `ETag`. This is why bucket CORS must expose `ETag`. `ListParts` supports resume, and `AbortMultipartUpload` supports cancel.
- **Size verification (TD-07 Revision):** `HeadObjectCommand` → `ContentLength`. Oversize → `DeleteObjectCommand` and the video goes to `failed`.
- **Streaming responses:** a `GetObjectCommand` body must always be fully consumed or discarded. Otherwise Node's sockets run out (SDK "effective practices"). This matters only if the worker ever downloads via the SDK rather than a presigned URL (TD-09 full-rewrite path).

### @aws-sdk/s3-request-presigner

Used by TD-04 (part URLs, TTL 1 h per TD-07) and TD-11 (playback and download URLs).

- `getSignedUrl(client, command, { expiresIn })`. `expiresIn` is in seconds and **defaults to 900** if not given. Pass an explicit TTL.
- **Download (TD-11 Revision):** `new GetObjectCommand({ Bucket, Key, ResponseContentDisposition: 'attachment; filename="<title>.<ext>"' })`. Response-header overrides only work on **signed** requests, which is what presigned URLs are.
- **Playback (TD-11):** a presigned GET on `playback.mp4`. Range requests (`Range: bytes=…` → `206`) are answered by S3/MinIO; no SDK code is involved.
- Sign with the **public-endpoint** client (see client-s3 notes above).

### @aws-sdk/lib-storage

Used by TD-01 for server-side uploads of large files (the worker's playback MP4).

- `new Upload({ client, params: { Bucket, Key, Body, ContentType }, partSize, queueSize }).done()` — splits a stream into a multipart upload, so objects above the 5 GB `PutObject` cap work. `partSize` is at least 5 MiB (the project uses `S3_UPLOAD_PART_SIZE_BYTES`, default 64 MiB); `queueSize` defaults to 4.
- Bodies at most one part long are sent as a single `PutObject`; the multipart ETag (`...-N`) only appears above `partSize`.
- On failure it aborts the multipart upload unless `leavePartsOnError` is set.

### ioredis

Used by TD-02: the Redis client BullMQ connects through, installed as an explicit dependency. The project code does not import it directly; connection options are passed to `BullModule.forRootAsync`.

### bullmq

Used by TD-02 (queue), TD-15 (failure policy) and TD-16 (sweep scheduler). The current major is **6**.

- **Retries (TD-15 A):** `queue.add(name, data, { attempts: 3, backoff: { type: 'exponential', delay } })`. Retries wait `2^(attempt-1) * delay`.
- **Fail fast:** `throw new UnrecoverableError(reason)` from the processor moves the job straight to failed, overriding `attempts`. Use it for permanent errors (no video stream, unreadable container).
- **Idempotent enqueue (TD-06 B):** a custom `jobId` (e.g. `videoId`) deduplicates. Adding a job whose id already exists is a no-op.
- **Failure hook:** the worker `'failed'` event `(job, err)` fires on final failure, including jobs that stalled after a worker crash and exhausted their attempts. This is where `processing_status = failed` + `failure_reason` is set (TD-15).
- **Job Schedulers (TD-16 A):** `queue.upsertJobScheduler(schedulerId, { every: ms } | { pattern: cron }, { name, data, opts })`.
  - **Upsert, not add:** it is idempotent across worker restarts and replicas.
  - **Single job in Redis:** exactly one delayed job per scheduler, so the schedule fires once per tick cluster-wide.
  - **Throttling:** the next job is produced only when the previous one **starts processing**, so use a dedicated `maintenance` queue to avoid starving behind FFmpeg jobs.
  - **First run is immediate:** for a newly created scheduler the first run happens right away. The `immediately` option was deprecated in 5.19.
  - **Removal:** call `removeJobScheduler(id)`.
  - **Legacy API:** v5's `repeat` job option is the old API. Its options map 1:1 to `upsertJobScheduler` (`every`, `pattern`, `limit`, `startDate`, `endDate`, `tz`; `utc: true` → `tz: 'UTC'`).

### @nestjs/bullmq

Used by TD-02 (Nest integration) and TD-03 (worker entrypoint with `WorkerModule`).

- **Connection:** `BullModule.forRootAsync({ imports: [ConfigModule], inject: [queueConfig.KEY], useFactory: (cfg) => ({ connection: { host, port } }) })`. This matches the inherited `registerAs` + `ConfigType` convention. Use the Compose service name for host (`redis`).
- **Queues:** `BullModule.registerQueue({ name: 'video-processing' }, { name: 'maintenance' })`. Producers inject with `@InjectQueue('video-processing') queue: Queue`.
- **Consumers:** `@Processor('video-processing', { concurrency })` on a class that **must extend `WorkerHost`**; otherwise registration throws `InvalidProcessorClassError`. Implement `async process(job)`: a rejection marks the attempt failed, and `attempts`/`backoff` apply.
- **Events:** `@OnWorkerEvent('failed')` (or `this.worker.on(...)` from `onApplicationBootstrap`). `this.worker` is only available after registration.
- **Placement (TD-03):** processors belong only in `WorkerModule` (worker entrypoint, `createApplicationContext`). `AppModule` (API) only registers queues as a producer, so the API process never consumes jobs.

### fluent-ffmpeg

Used by TD-08 B (exact pin 2.1.3; deprecated on npm, CLI wrapper only), TD-09 (URL input), TD-10 (faststart MP4) and TD-13 (thumbnail).

- **Probe (duration/metadata):** `ffmpeg.ffprobe(input, (err, data) => …)`. Duration is in `data.format.duration` (a string, in seconds). Streams are in `data.streams[]` (`codec_type`, `codec_name`, `width`, `height`). No `codec_type === 'video'` stream means a permanent error (`UnrecoverableError`, TD-15). The input can be an HTTP(S) URL (TD-09 C: probe via presigned URL).
- **Thumbnail:** `screenshots({ timestamps: [...], filename, folder, size })` does **not** work on input streams and "doesn't interact well with filters". TD-13 B uses a seek + `thumbnail` video filter + `scale=1280:-2`, so build it as a normal output command instead: `ffmpeg(input).seekInput(t).videoFilters(['thumbnail', 'scale=1280:-2']).frames(1).output(jpgPath)`.
- **Playback MP4 (TD-10 B):** H.264/AAC with `.outputOptions('-movflags +faststart')`, written to a **file**, not a pipe. `faststart` needs a seekable output; fragmented `frag_keyframe` is only for non-seekable pipes, which TD-10 doesn't use.
- **Events:** `.on('error', (err) => …)` and `.on('end', …)`. Wrap them in a Promise inside the single `FfmpegService` (TD-08 Revision).

### @types/fluent-ffmpeg

Type definitions for `fluent-ffmpeg` 2.1.x (DefinitelyTyped). It is a dev dependency only. `FfprobeData`, `FfprobeStream` and `FfmpegCommand` are the types that `FfmpegService`'s typed results should wrap (TD-08 Revision), so the processor never sees raw wrapper types.
