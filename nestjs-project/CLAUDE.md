# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, etc.) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`
- **Redis:** `docker compose ps redis` — expect `healthy` (the service has a `redis-cli ping` healthcheck)
- **MinIO:** `docker compose ps minio` — expect `running` (the image is distroless and has no healthcheck); then confirm `docker compose ps -a minio-init` shows `Exited (0)`, meaning the bucket, the public-read policy on `thumbnails/` and the bucket notification were applied
- **Video worker:** `docker compose logs video-worker --tail 5` — expect `Video worker started`

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000`
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`
- `mailpit` — SMTP sink for development
- `minio` — S3-compatible object storage, API on `9000`, console on `9001`
- `minio-init` — one-shot bootstrap (`scripts/minio-init.mjs`): creates the bucket, applies the public-read policy on `thumbnails/*` and registers the bucket notification that calls the API
- `redis` — Redis 7.4 (BullMQ), port `6379`
- `video-worker` — the queue consumer: `npm run start:worker:dev`, started automatically by Compose (unlike `nestjs-api`, whose dev server is started on demand)

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Check container logs
docker compose logs nestjs-api
docker compose logs db

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build

npm test                                 # Unit tests
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (always with --runInBand)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose exec db pg_isready -U streamtube
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share a single test database. They **must** be run with `--runInBand`:

```bash
docker compose exec nestjs-api npm test -- --runInBand
docker compose exec nestjs-api npm run test:e2e   # already configured
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

Tests that touch storage or queues use the **real** MinIO and Redis from Compose (never mocks), reached by service name:

- **Bucket:** call `useTestBucket()` (`src/test/s3.ts`) before the Nest module is created; it points `S3_BUCKET` at `<S3_BUCKET>-test`. Reset it with `emptyTestBucket()` in `beforeEach`. `S3_TEST_BUCKET` overrides the name.
- **`S3_PUBLIC_ENDPOINT`:** in `.env` it is a host address (`localhost:9000`), unreachable from the container. Specs that fetch presigned URLs set `process.env.S3_PUBLIC_ENDPOINT = process.env.S3_ENDPOINT` before bootstrapping the app.
- **BullMQ:** the `video-worker` container consumes the default `bull` prefix, so every spec that enqueues sets a unique `process.env.QUEUE_PREFIX` first and calls `queue.obliterate({ force: true })` in `beforeEach`/`afterAll`.
- **Media fixtures:** `src/test/media.ts` generates MP4/WebM/audio-only/garbage files with the container's FFmpeg; nothing binary is committed.
- **Async outcomes** (a worker event handler, a processed job) are awaited with `waitFor()` from `src/test/wait-for.ts`, never with fixed sleeps.

Run the worker by hand with `docker compose exec video-worker npm run start:worker:dev` (it already runs as a Compose service; restart it with `docker compose restart video-worker` after changing its code).

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config"]` — without this, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## Videos

Upload, background processing and delivery of videos. Decisions: `docs/decisions/technical-decisions-phase-03-videos.md`; plan: `docs/phases/phase-03-videos/`.

### Layout

- `src/videos/` — `VideosModule`: `VideosController`/`VideosService` (public API), `entities/video.entity.ts`, `dto/`, `videos.constants.ts` (status enum, failure reasons, limits), `public-id.ts`, `content-disposition.ts`
  - `storage-events/` — the internal webhook (`StorageEventsController`, `StorageEventsService`, `StorageWebhookTokenGuard`, S3 event parser)
  - `processing/` — worker side: `VideoProcessor`, `FfmpegService` (the only place that imports `fluent-ffmpeg`), `PermanentMediaError`, `VideoProcessingModule`
  - `maintenance/` — `StaleUploadSweepService`, `MaintenanceProcessor`, `StaleUploadSweepScheduler`, `MaintenanceModule`
- `src/storage/` — `StorageService`: the only code that talks to the S3 API (multipart, presigned URLs, upload/download of files). Two S3 clients: an internal one (Compose network) and a public one used only to sign URLs the browser consumes.
- `src/queue/` — `QueueModule` (BullMQ connection, the two queues) and `queue.constants.ts` (queue/job names, retry policy)
- `src/worker.ts` + `src/worker.module.ts` — second entrypoint (application context, no HTTP). **Every `@Processor` is registered only in `WorkerModule`**, never in `AppModule`.

### Endpoints

All `/videos` routes are owner-only (global JWT guard) and `@SkipThrottle()`. A video that does not exist or belongs to another channel answers `404 VIDEO_NOT_FOUND`.

| Route | Purpose |
|---|---|
| `POST /videos` | Create the draft and open the S3 multipart upload (returns `part_size` 64 MiB and `part_count`) |
| `POST /videos/:publicId/upload/part-urls` | Presigned `UploadPart` URLs (1 h) |
| `GET /videos/:publicId/upload/parts` | Parts already stored, to resume |
| `POST /videos/:publicId/upload/complete` | Finish the multipart upload (`202`); does **not** start processing |
| `GET /videos/:publicId` | Status for polling, metadata, public `thumbnail_url` once `ready` |
| `GET /videos/:publicId/playback-url` | Presigned URL of `playback/{id}.mp4`; stream with `Range` (`206`). `409 VIDEO_NOT_READY` unless `ready` |
| `GET /videos/:publicId/download-url` | Presigned URL of the original as an attachment. `409 VIDEO_NOT_READY` unless `ready` |
| `POST /internal/storage-events` | Bucket notification webhook. `@Public()` (no JWT), authenticated by `Authorization: Bearer $STORAGE_WEBHOOK_TOKEN`, excluded from OpenAPI |

### Status cycle

`processing_status`: `uploading` → `processing` → `ready` | `failed`. `published_at` is `NULL` (draft) throughout; publishing belongs to a later phase.

- The **storage event**, not the `complete` call, moves `uploading → processing`: it re-checks the real size with `HeadObject` and enqueues `process-video` with `jobId = videoId`.
- Every transition out of `uploading`/`processing` is a conditional `UPDATE ... WHERE processing_status = ...`, because the event consumer, the processor and the sweep can race.
- `failure_reason`: `file_too_large` (event consumer), `upload_expired` (24 h sweep), `not_a_video` (permanent media error, no retry), `processing_failed` (transient errors after the 3rd attempt).

### Storage keys

One bucket (`S3_BUCKET`): `originals/{id}/source{ext}` (kept, private, the download source), `playback/{id}.mp4` (private, faststart H.264/AAC), `thumbnails/{id}.jpg` (public-read, 1280 px wide). `{id}` is the internal UUID; URLs and the API use the 11-char `public_id`.

### Queues

- `video-processing` / `process-video`: 3 attempts with exponential backoff (`VIDEO_PROCESSING_BACKOFF_MS`); `UnrecoverableError` skips retries. The `failed` hook sets the terminal state only on the last attempt or on a permanent error.
- `maintenance` / `sweep-stale-uploads`: job scheduler `stale-upload-sweep`, every hour, registered idempotently at worker boot.

### Environment

`S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET`, `S3_DELIVERY_URL_TTL_SECONDS`, `STORAGE_WEBHOOK_TOKEN`, `REDIS_HOST`, `REDIS_PORT`, `QUEUE_PREFIX`, `VIDEO_PROCESSING_BACKOFF_MS`, `PROCESSING_TMP_DIR` (see `.env.example`). Hosts are Compose service names (`minio`, `redis`) — **except `S3_PUBLIC_ENDPOINT`**, which must be reachable from the browser (`http://localhost:9000` in dev) because presigned URLs are signed against it.

The MinIO notification target (`MINIO_NOTIFY_WEBHOOK_*` in `compose.yaml`) calls `http://nestjs-api:3000/internal/storage-events`, so it only delivers while the API dev server is running; events raised meanwhile wait in MinIO's persistent queue (`/data/.events`).

### OpenAPI

The video endpoints are documented in `openapi.json`; regenerate it with `docker compose exec nestjs-api npm run openapi:export` (a test fails when the committed file is stale). The frontend copy is synced from the repo root with `scripts/sync-openapi.sh`, then `npm run openapi:types` in `next-frontend`.

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.
