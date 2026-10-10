---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-10-09
scope_description: "Backend + cross-layer side of Phase 03 — object storage, background job queue and worker topology, the 10GB resumable upload protocol, video lifecycle modeling, upload validation/limits, FFmpeg-based metadata extraction and thumbnail generation, streaming delivery format, media delivery/URL signing (streaming + download), the unique public video ID, and the processing failure policy. Phase 03 is a backend-only delivery (per docs/phases/phase-03-videos/enunciado.md); frontend consumption of these contracts is deferred to Phases 04/05."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos (Backend + Cross-layer)

_Subprojects in scope:_

- `nestjs-project/` — primary subproject. Receives the new `VideosModule` (entity, upload control-plane endpoints), the storage module (S3 client + presigner), the queue wiring, the video worker entrypoint, FFmpeg integration, and new Compose services (queue broker, object storage, worker) in `nestjs-project/compose.yaml`.
- `next-frontend/` — **no TD and no implementation work in Phase 03.** The challenge brief (`docs/phases/phase-03-videos/enunciado.md`) defines Phase 03 as a backend delivery: "a interface de vídeo não faz parte do escopo desta fase". Cross-layer TDs below (TD-04, TD-05, TD-07, TD-10, TD-11, TD-12, TD-14) fix the API contract and describe the FE side only so that Phases 04/05 inherit a stable contract; the upload UI, client library and player are built there.

> Cross-doc anchors (already decided — do NOT reopen):
> - **Strict BFF — single server-only `API_URL`:** `next-frontend-config-base/TD-03`. The browser never talks to NestJS; all control-plane calls go through `app/api/**` Route Handlers. The C4 diagram (`docs/diagrams/software-arch.mermaid`) already shows `Frontend → Object Storage` directly ("Streams"), so direct browser↔storage byte transfer is **not** a BFF violation — it is not NestJS traffic.
> - **Config system:** `@nestjs/config` + Joi + `registerAs` namespaces (`phase-01-configuracao-base/TD-01..TD-04`). New env keys (storage, queue) are added to `env.validation.ts` and a new namespaced config each.
> - **Auth:** custom `@nestjs/jwt` guards, `Authorization: Bearer` (`phase-02-auth/TD-02`). Upload endpoints are authenticated with the existing guard; ownership checks are an implementation concern.
> - **Validation & errors:** class-validator DTOs (`phase-02-auth/TD-06`); domain exception filter with `{ statusCode, error, message }` envelope (`phase-02-auth/TD-07`). New upload error codes follow the envelope.
> - **Channel ownership:** each user has exactly one `Channel` (`channels.user_id` unique). Videos belong to a channel.
> - **OpenAPI chain:** `@nestjs/swagger` + exported `openapi.json` (`openapi-docs-nestjs/TD-01..TD-02`) feeds FE codegen (`next-frontend-openapi-typing/*`). Every new endpoint in this phase lands in the spec.

> Findings that shape this document:
> - **MinIO community edition is no longer distributed as images.** Official Docker images stopped being published in Oct/2025; the repo entered maintenance mode in Dec/2025 and was later archived. Source remains AGPLv3. This directly affects TD-01.
> - **The current testing guide conflicts with direct-to-storage uploads.** `.claude/skills/testing-guide-nestjs-project/references/external-systems.md` prescribes "Object Storage — Local Filesystem in dev/tests, S3 in production". A local filesystem cannot serve presigned multipart URLs, so if TD-04 picks Option A the guide must be revised (see Notes).
> - **`fluent-ffmpeg` is deprecated on npm** (last release 2.1.3, May/2024). Affects TD-08.
> - **Uppy 6 rewrote `@uppy/aws-s3`:** the six per-operation callbacks were replaced by a single `signRequest` (or `getCredentials`), and Uppy performs the S3 calls itself. This interacts with TD-04/TD-06 (server-mediated completion) and is flagged for the frontend doc.
> - **Docker networking vs. presigned URLs:** containers reach storage by Compose service name, but a presigned URL is consumed by the browser on the host. SigV4 signs the host, so URLs must be signed against a browser-reachable endpoint. This is a cross-component env contract (TD-11).

---

## TD-01: Object Storage Server (dev/test) and Access SDK

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** Phase 03 introduces the Object Storage container from the C4 diagram ("S3 or MinIO"). Production is S3 (per the testing guide); dev and tests need something local that behaves like S3 closely enough for presigned multipart uploads (TD-04), range GETs (TD-10/TD-11), CORS from the browser origin, and lifecycle rules (TD-07). In every option the backend talks to storage through `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` (`forcePathStyle: true` for self-hosted servers), so the decision is which server runs in `compose.yaml`.

**Options:**

### Option A: MinIO, pinned image (last official tag or Chainguard's free image)
- Run MinIO as a dev/test-only S3 emulator, pinned to a fixed image tag. Bucket, CORS and lifecycle are set up by an init step (`mc`) in Compose.
- **Pros:** The most widely documented self-hosted S3 target: presigned multipart, range GET, lifecycle `AbortIncompleteMultipartUpload` and permissive dev CORS all work. Every S3 SDK sample works against it unchanged. Single container.
- **Cons:** **Upstream is no longer maintained or distributed** (see findings). A pinned image gets no new fixes. Acceptable only because it never runs in production, but it is a dead dependency to plan around.

### Option B: SeaweedFS (S3 gateway, `weed server -s3`)
- Apache-2.0, actively maintained distributed store with an S3-compatible gateway. Single container in dev mode.
- **Pros:** Maintained, permissive license, high S3 API coverage, long production track record.
- **Cons:** More operational surface (master/volume/filer concepts, even in single-node mode). Fewer copy-paste examples for presigned multipart + browser CORS, so this setup must be verified first. S3 identity/config uses its own JSON format.

### Option C: Garage
- AGPL-3.0 lightweight S3-compatible store designed for small clusters.
- **Pros:** Maintained, small footprint, simple to run.
- **Cons:** Narrower S3 API surface, and bucket/key creation needs a CLI bootstrap (`garage layout`, `garage key`) before first use. Less tooling familiarity. Coverage of every call the upload flow needs must be verified.

### Option D: Local filesystem adapter behind a `StorageService` abstraction (current testing-guide strategy)
- Dev/tests write to a local directory; production switches to S3 via an adapter.
- **Pros:** Zero new infra. Matches the testing guide as written today.
- **Cons:** **Incompatible with presigned direct uploads (TD-04 A) and presigned streaming (TD-11).** The browser would have to send bytes through the API, which contradicts the "sem impacto na performance" capability. Dev and prod would run different code paths.

**Recommendation:** **Option A (MinIO, pinned)**, used strictly as a dev/test emulator, with the code bound only to the S3 API through the AWS SDK v3. Replacing the server later (with B, if MinIO's frozen state becomes a problem) is then a `compose.yaml` change, not a code change. MinIO gives the fastest path to a working presigned-multipart + CORS + lifecycle setup, and those are exactly the behaviors TD-04/07/11 depend on. Its abandonment is a real cost, but it is bounded because production is S3. Option B is the honest maintained alternative and becomes the recommendation if the team does not accept a frozen dev dependency. Option D is rejected because it cannot support direct-to-storage transfer. Choosing A, B or C requires revising the testing guide's storage section (see Notes).

**Decision:** : **Option A (MinIO, pinned)**
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

**Revisions:**
- 2026-10-10 — `**Libraries:**` field filled with the AWS SDK v3 packages the Recommendation already names (S3 client +
  presigner for multipart parts and GET URLs). Rationale: resolves validation IC-3 — the empty field kept these
  dependencies out of library-refs.md and doc lookups. Decision A unchanged.
- 2026-10-10 — Aligned with the challenge brief (`docs/phases/phase-03-videos/enunciado.md`, "Sobre o object storage").
  - The storage server is **given, not open**: S3-compatible, with MinIO locally in Docker and S3 in production. Options B/C stay recorded only as a contingency if the pinned MinIO image becomes unusable.
  - What this TD fixes is **how storage is used**: a **single bucket** (name from env), with keys organized by prefix:
    - `originals/{videoId}/source{ext}`: the kept upload. Download source; bucket notification scope (TD-06 B).
    - `playback/{videoId}.mp4`: the streaming source (TD-10 B).
    - `thumbnails/{videoId}.jpg`: under the public-read prefix (TD-11 D).
  - Uploads are presigned multipart (TD-04 A).
  - Rationale: the brief states the decision is "*como* usá-lo (organização de buckets/chaves, upload pré-assinado), não *qual* storage". Decision A unchanged.

---

## TD-02: Background Job Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The C4 diagram leaves the Message Queue as "TBD". The queue carries video-processing jobs from the API (publisher) to the Video Worker (consumer, TD-03). Jobs are few but long-running (seconds to minutes per video) and must survive restarts, retry on transient failures (storage hiccups, FFmpeg crashes) and report failure in a way that ends in `failed` status (TD-05). The testing guide already expects a real broker in Docker and sketches a BullMQ setup.

**Options:**

### Option A: BullMQ + Redis via `@nestjs/bullmq`
- Redis-backed queue with an official NestJS module (`BullModule.forRoot/registerQueue`, `@Processor` + `WorkerHost`). Adds a `redis` Compose service.
- **Pros:** First-party Nest integration and DI. Built-in attempts/backoff, job progress, concurrency per worker, stalled-job recovery, and `jobId` dedup for idempotent enqueue. Mature and actively developed. Matches the testing guide's sketch, so test patterns already exist.
- **Cons:** New infrastructure (Redis) to run and configure: persistence, and `maxmemory-policy noeviction` so jobs are never evicted. One more service to keep healthy in Compose and production.

### Option B: pg-boss (PostgreSQL-backed)
- Job queue on top of the existing PostgreSQL using `SKIP LOCKED`; per-queue partitioned tables since v10.
- **Pros:** **No new infrastructure** — reuses the `db` service. Jobs are transactional with domain writes (enqueue in the same transaction that creates/updates the video).
- **Cons:** No official Nest module, so the wrapper is hand-written. Smaller ecosystem and fewer built-in features (progress reporting, UI tooling). Adds polling load on the primary DB, which is acceptable at this scale but couples queue health to DB health.

### Option C: RabbitMQ (`@nestjs/microservices` AMQP transport or `amqplib`)
- General-purpose message broker with acknowledgements and dead-letter exchanges.
- **Pros:** Powerful routing, standard protocol, language-agnostic consumers.
- **Cons:** Heaviest operational footprint. Retry with backoff requires DLX/TTL plumbing instead of a job option. The microservices transport is message-oriented, not job-oriented (no progress, no job state to query). Overkill for one job type.

**Recommendation:** **Option A (BullMQ + Redis)**. The workload is job-shaped: long-running, retryable, with progress and per-job state the API may read back (TD-14). BullMQ models that natively, and `@nestjs/bullmq` gives the worker (TD-03) a first-party processor abstraction. Redis is a small, well-understood addition, and the testing guide already assumes it. Option B is a legitimate choice if the team prefers zero new infrastructure: its transactional enqueue is a real advantage, paid for with a hand-written integration. Option C buys routing flexibility the project does not need.

**Decision:** **Option A (BullMQ + Redis)**
**Libraries:** bullmq, @nestjs/bullmq

**Revisions:**
- 2026-10-10 — `**Libraries:**` field filled with `bullmq` and `@nestjs/bullmq`, as the Recommendation names; the
  installed BullMQ major must provide Job Schedulers (`upsertJobScheduler`), which TD-16 relies on. Rationale: resolves
  validation IC-3 — the empty field kept these dependencies out of library-refs.md and doc lookups. Decision A unchanged.

---

## TD-03: Video Worker Topology

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The C4 diagram draws the Video Worker (FFmpeg) as a container separate from the API. FFmpeg work is CPU- and IO-heavy; the phase requires uploads and processing to happen "sem impacto na performance". The question is where the job consumer runs and how much code it shares with the API (entities, config, storage module). Depends on TD-02 (consumer API shape).

**Options:**

### Option A: Separate container, same codebase, second entrypoint
- `src/worker.ts` boots `NestFactory.createApplicationContext(WorkerModule)` (no HTTP server). `WorkerModule` imports the shared config, TypeORM, storage and queue modules plus the processor. Compose adds a `video-worker` service from the same image (with FFmpeg installed) running a different command.
- **Pros:** Matches the C4 container boundary. **FFmpeg CPU never competes with API request handling.** Workers scale independently (replicas, concurrency). Entities, config namespaces, the storage service and Joi validation are shared, so nothing is duplicated. One `package.json`, one test setup.
- **Cons:** Two processes to start in dev (two Compose services). The API image also carries the FFmpeg binary unless a separate build stage/target is used. Module boundaries must keep the processor out of `AppModule`.

### Option B: In-process processor inside the API container
- Register the `@Processor` in `AppModule`; the API process consumes jobs itself.
- **Pros:** Simplest setup — one process, one container.
- **Cons:** **FFmpeg child processes and stream IO run on the same container/CPU quota as HTTP traffic**, which works directly against the phase's performance requirement. Cannot scale processing independently. Diverges from the C4 diagram.

### Option C: Separate subproject (`video-worker/`) with its own `package.json`
- A standalone Node (or other-language) service that consumes the queue and writes to DB/storage.
- **Pros:** Strongest isolation; could use a different stack if ever desired.
- **Cons:** Duplicates entities, config validation and the storage client across subprojects, or forces a shared-package/monorepo-tooling decision (out of scope). The worker writes the `videos` table, so a second owner of that schema risks drift. Much more setup for no functional gain now.

**Recommendation:** **Option A (separate container, same codebase, second entrypoint)**. It implements the C4 boundary and the performance requirement (processing is isolated from the API) while keeping a single owner of the `Video` entity and config, which matches the project's Single Responsibility principle without creating a second subproject. The FFmpeg-in-API-image cost is cosmetic in dev and can be removed later with a multi-stage build target.

**Decision:** **Option A (separate container, same codebase, second entrypoint)**

---

## TD-04: Upload Protocol for ≤10GB Resumable Uploads

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** The core decision of the phase. Requirements: files up to 10GB; no impact on system performance; resumable after a connection drop (project-plan § Pontos de Atenção). Constraints: strict BFF (browser → Next `app/api/**` → Nest only), so streaming 10GB through a Next Route Handler and then through Nest would put the whole payload on two Node processes. Both sides are affected: the backend defines the control-plane endpoints and storage interactions; the frontend implements chunking, parallelism, retry and resume against that contract.

**Options:**

### Option A: S3 multipart upload with presigned part URLs (browser → storage direct), API-mediated control plane
- Through the BFF, the client calls the API to **initiate**: the API creates the draft video (TD-05), calls `CreateMultipartUpload`, and returns `uploadId`, part size and presigned `UploadPart` URLs (batched or on demand). The browser PUTs parts **directly to storage**. The client calls **complete**, and the API runs `CompleteMultipartUpload` (TD-06). **List parts** (resume) and **abort** are also API endpoints.
- **Backend:** small JSON endpoints only. Bytes never touch Nest or Next. Needs the bucket CORS for the FE origin to expose `ETag`.
- **Frontend:** a client that chunks the `File`, PUTs parts in parallel, collects ETags, and resumes via list-parts. Uppy 6's `@uppy/aws-s3` (`signRequest` mode) or a custom uploader — decided in the FE doc, which must stay compatible with server-mediated Create/Complete.
- **Pros:** **Zero upload bandwidth on API/BFF**, which meets "sem impacto na performance" by construction. Native S3 resume semantics (parts already uploaded are listed and skipped). Per-part retries. Identical behavior against MinIO and S3. Keeps the strict BFF intact for all NestJS traffic.
- **Cons:** More moving parts in the client (part bookkeeping, ETag collection). Presigned URL expiry must cover slow parts. CORS must be configured on the bucket. The storage endpoint must be browser-reachable (TD-11's public-endpoint contract).

### Option B: tus protocol (`@tus/server` + `@tus/s3-store`)
- A tus server receives resumable `PATCH` chunks and writes them to S3 via multipart behind the scenes. The client uses `tus-js-client` or Uppy's tus plugin.
- **Backend:** host `@tus/server` mounted in Nest (Express adapter) or as a separate tus service. Completion via the `onUploadFinish` hook.
- **Frontend:** standard tus client, with resume built into the protocol (`HEAD` for offset).
- **Pros:** Mature open resumable protocol, a simple client, and resume-after-reload with fingerprinting out of the box.
- **Cons:** **All bytes flow through the tus server.** If it lives in Nest, the API carries 10GB streams (performance impact) and the browser must reach Nest directly, breaking the strict BFF. Proxying through Next is worse still. A separate public tus service avoids both but adds a new internet-facing container with its own auth integration. S3 store part size is bound to ≥5MiB.

### Option C: Custom chunked upload through BFF → API → storage
- The client slices the file and POSTs chunks to a Next Route Handler, which forwards each to a Nest endpoint that writes the part to storage.
- **Pros:** Uses only existing surfaces; no CORS on storage; every byte is authenticated by the BFF.
- **Cons:** **Each byte crosses two Node processes**, so 10GB uploads saturate the BFF and API — directly against the capability. Custom resume protocol to design and test. Strictly dominated by A.

**Recommendation:** **Option A (S3 multipart with presigned parts, API-mediated control plane)**. It is the only option where 10GB of bytes touch neither Next nor Nest without introducing a new public service, which satisfies both the performance capability and the strict BFF. Resume falls out of S3's own list-parts semantics. Keeping Create/Complete on the server is deliberate: the API learns about completion synchronously, which is the trigger for processing (TD-06) and the point where size validation happens (TD-07). The frontend doc must pick a client configuration that respects this; Uppy 6's `signRequest` mode moves Create/Complete to the client, so it either needs a server-mediated wrapper or a custom uploader.

**Decision:** **Option A (S3 multipart with presigned parts, API-mediated control plane)**

**Revisions:**
- 2026-10-10 — Recommendation's completion rationale superseded: under TD-06 B the `complete` endpoint only runs
  `CompleteMultipartUpload` and returns `202 Accepted`; the processing trigger and the size check live in the TD-06 B
  storage-event consumer (TD-07 Revision), not in `complete`. Rationale: aligned with the TD-06 B decision. Decision A
  (S3 multipart, presigned parts, API-mediated Create/Complete) unchanged.

---

## TD-05: Video Lifecycle Status Modeling

**Scope:** Cross-layer

**Capability:** Pré-cadastro automático do vídeo como rascunho ao iniciar o upload

**Context:** A `videos` row is created when the upload starts (draft pre-registration). From there the video moves through upload → processing → ready (or failed). Phase 04 then adds draft → published and public/unlisted visibility. The shape chosen now is consumed by the frontend (status badges, polling stop condition in TD-14, Phase 04's management panel) and by every later phase's queries ("only ready + published + public in listings").

**Options:**

### Option A: Single `status` enum covering everything
- `status ∈ { uploading, processing, ready, failed, published }`, possibly growing to more states in later phases.
- **Pros:** One column, one switch statement.
- **Cons:** **Mixes two independent axes.** "Published but reprocessing", or "draft that failed processing", need extra states or become impossible. Phase 04's draft/publish flow would have to rewrite the enum and every query using it. Listing filters become `IN (...)` lists that drift.

### Option B: Two orthogonal fields — processing pipeline + publication state
- `processing_status ∈ { uploading, processing, ready, failed }` (owned by this phase) plus a publication field defaulting to draft (e.g., `published_at: timestamp | null`, or a `publication_status` enum). Phase 04 owns the transitions of that field; visibility (public/unlisted) is a Phase 04 column.
- **Pros:** **Each phase owns its axis.** Phase 03 never touches publication; Phase 04 never touches processing. Draft is the default at pre-registration, which satisfies the capability with no Phase 04 logic. Queries compose cleanly (`processing_status = 'ready' AND published_at IS NOT NULL`). The FE renders two independent indicators.
- **Cons:** Two fields to keep consistent (e.g., Phase 04 must forbid publishing unless `ready` — a domain rule, not a modeling problem).

### Option C: Boolean flags (`is_uploaded`, `is_processed`, `is_published`, `has_failed`)
- **Pros:** Trivial to add incrementally.
- **Cons:** Allows invalid combinations (`has_failed && is_processed`). No explicit state machine. Every reader must re-derive the state. Dominated by B.

**Recommendation:** **Option B (two orthogonal fields)**. The processing pipeline and the publication workflow are owned by different phases and change for different reasons. Separating them follows the project's Single Responsibility principle at the data-model level and spares Phase 04 from migrating an enum this phase created. The pre-registration capability is met by the publication field's draft default.

**Decision:** **Option B (two orthogonal fields)**

**Revisions:**
- 2026-10-10 — Explicit mapping to the challenge brief's status cycle ("rascunho → processando → pronto/erro"):
  "rascunho" = `published_at IS NULL` (default at pre-registration) while `processing_status = uploading`;
  "processando" = `processing_status = processing`; "pronto/erro" = `processing_status = ready | failed`.
  `published_at` has no transitions in Phase 03 (owned by Phase 04). Rationale: the brief's acceptance criterion
  requires the cycle to be visibly reflected in the database; the two-axis model satisfies it and this entry makes
  the correspondence traceable.

---

## TD-06: Upload Completion Signal and Processing Job Trigger

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance"

**Context:** With direct-to-storage uploads (TD-04 A), the API is not in the byte path, so something must tell it the upload finished in order to move the video to `processing` and enqueue the job (TD-02). Depends on TD-04.

**Options:**

### Option A: Client-driven completion call
- The client calls `complete` with the part list. The API runs `CompleteMultipartUpload`, verifies the object with `HeadObject` (TD-07), sets `processing_status = processing` and enqueues the job with `jobId = videoId` (idempotent) — in that order.
- **Pros:** **Portable** across MinIO, SeaweedFS and S3 with no server-specific config. Synchronous: the client gets an immediate success/failure. Single code path in dev, test and prod. Easy to test (integration test calls the endpoint and asserts the queued job).
- **Cons:** If the client disappears after the last part but before `complete`, the upload is left incomplete. That case is covered by TD-07's cleanup and leaves no bad state.

### Option B: Storage event notifications
- Configure the bucket to emit `s3:ObjectCreated:CompleteMultipartUpload` events (a MinIO webhook/Redis target, or S3 → SQS/EventBridge); a consumer enqueues the job.
- **Pros:** Completion is detected even when the client never reports it.
- **Cons:** **Server-specific configuration** (MinIO notification targets ≠ AWS EventBridge/SQS), so dev and prod diverge. The client still needs `complete` under TD-04 A (multipart is only finalized by `CompleteMultipartUpload`), so B adds a second signal without removing the first. Harder to test.

### Option C: Client completion + periodic reconciliation sweep
- Option A, plus a scheduled job that lists in-progress multipart uploads and reconciles stuck videos.
- **Pros:** Self-healing for edge cases.
- **Cons:** Reconciliation logic overlaps with TD-07's cleanup policy. More code for a failure mode that A + lifecycle cleanup already handle.

**Recommendation:** **Option A (client-driven completion call)**. Under TD-04 A the client must call complete anyway to finalize the multipart upload, so making that call also the processing trigger adds no new signal and is identical across storage servers. Idempotent enqueue (`jobId = videoId`) makes retried `complete` calls safe. Abandoned uploads are TD-07's job.

**Decision:** **Option B: Storage event notifications**

**Revisions:**
- 2026-10-10 — Rationale for choosing B over the recommendation, and the resulting mechanics. Rationale: processing
  is triggered by a fact recorded by the storage (the object now exists), not by a client report, so a client that
  disappears after `CompleteMultipartUpload` or a retried request cannot skip or duplicate processing; the trigger
  is the same no matter which client (FE, script, future mobile app) performed the upload. Mechanics:
  (1) the API `complete` endpoint still runs `CompleteMultipartUpload` (required by TD-04 A — S3 only finalizes a
  multipart upload through that call) and returns `202 Accepted`, but **does not enqueue**;
  (2) the bucket publishes `s3:ObjectCreated:CompleteMultipartUpload` for the originals prefix to an internal API
  webhook (`POST /internal/storage-events`), authenticated by a shared token from env and excluded from the global
  JWT guard (MinIO `notify_webhook` target, configured in the Compose init step);
  (3) the consumer resolves the video from the object key, applies TD-07's size verification, moves
  `processing_status` to `processing` and enqueues with `jobId = videoId` (idempotent against duplicate events);
  (4) in production the same consumer service is fed by S3 → SQS/EventBridge through an adapter — only the transport
  differs, the domain logic is shared. Accepted cost: server-specific notification config in dev vs prod.

---

## TD-07: Upload Validation and Limits Policy

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** With presigned direct uploads, the API never sees the bytes, so the 10GB cap and "is this actually a video?" must be enforced elsewhere. Several values here are shared contract between backend and frontend: max size, accepted MIME types/extensions, part size (S3 limits: 5MiB–5GiB per part, ≤10,000 parts), presigned URL TTL, and what happens to abandoned uploads. Depends on TD-04.

**Options:**

### Option A: Declare-and-verify, server-dictated part size, worker as final authority, storage-side cleanup
- **Init:** the client declares `size`, `mimeType` and `filename`. The API rejects `size > 10GB` or a MIME type outside an allowlist (`video/*` subset), then **returns the part size** (e.g., 64MiB → ~160 parts for 10GB) and the part count it will sign. It never signs part numbers beyond that count.
- **Complete:** `HeadObject` confirms the final size ≤ declared ≤ 10GB, otherwise the object is deleted and the video marked `failed`.
- **Worker:** `ffprobe` is the content authority. A non-video or unreadable file goes to `failed` with a machine-readable reason.
- **Cleanup:** a bucket lifecycle rule `AbortIncompleteMultipartUpload` (e.g., 1–2 days) plus a periodic sweep that marks/deletes drafts stuck in `uploading`.
- **Pros:** Every limit is enforced server-side even though bytes bypass the API. The part size is a single server-owned value, so the FE cannot pick an incompatible one. Real content validation comes from FFmpeg, which the worker runs anyway. Cleanup is mostly declarative (storage lifecycle).
- **Cons:** A malicious client can still upload up to `partCount × partSize` before `HeadObject` catches it (bounded by the signed part count). Needs a sweep job (a scheduled BullMQ job or `@nestjs/schedule`).

### Option B: Client-side checks + worker validation only
- The FE enforces size and type; the API trusts the declaration and only the worker validates.
- **Pros:** Least backend code.
- **Cons:** **The 10GB cap is not enforced server-side**, since any script can ignore the FE. Part size is chosen by the client, so contract drift is likely. No cleanup story.

### Option C: Server-side content sniffing before signing remaining parts
- After part 1, the API reads the first bytes (magic number / `ffprobe` on a range) and only then signs the remaining parts.
- **Pros:** Rejects non-video files early, before 10GB is transferred.
- **Cons:** Adds a sequential round-trip and server-side read at the start of every upload. More complex client state machine. Early rejection is a UX nicety, not a requirement. Can be added later on top of A.

**Recommendation:** **Option A (declare-and-verify + server-dictated part size + ffprobe authority + lifecycle cleanup)**. It is the only option that enforces the 10GB capability on the server with direct uploads. It also makes the part size a server-owned contract value returned by the init endpoint, so the frontend doc does not need to re-decide it. The concrete values (part size, URL TTL, allowlist, lifecycle days) are parameters for `/plan-build`; the policy shape is what this TD fixes.

**Decision:** **Option A: Declare-and-verify, server-dictated part size, worker as final authority, storage-side cleanup**

**Revisions:**
- 2026-10-10 — Size verification moves from the `complete` endpoint to the TD-06 B event consumer (event `size` +
  `HeadObject`; oversize → object deleted, video `failed`). Concrete values fixed: max size 10 GiB
  (10 737 418 240 bytes); part size 64 MiB (≤160 parts); upload-part URL TTL 1 h; MIME allowlist `video/mp4`,
  `video/quicktime`, `video/webm`, `video/x-matroska`; bucket lifecycle `AbortIncompleteMultipartUpload` after 1 day;
  periodic sweep marks videos still `uploading` after 24 h as `failed`. Init accepts an optional `title`
  (1–100 chars), defaulting to the filename without extension (truncated to 100). Rationale: TD-06 changed the
  completion signal; the values were left to planning and the brief requires the persisted video to have a title.

---

## TD-08: FFmpeg Integration Approach

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The worker (TD-03) needs `ffprobe` (duration, codecs, resolution, bitrate) and `ffmpeg` (thumbnail, TD-13; remux/transcode, TD-10). The decision is how the binaries get into the runtime and how Node invokes them. The most popular wrapper, `fluent-ffmpeg`, is deprecated.

**Options:**

### Option A: System FFmpeg in the worker image + `child_process.spawn` with a small typed wrapper
- `apt install ffmpeg` in the Dockerfile. A thin `FfmpegService` spawns `ffprobe -v error -print_format json -show_format -show_streams <input>` and parses the JSON into a typed result. ffmpeg commands are built as argument arrays (no shell).
- **Pros:** **No deprecated dependency.** The container pins the FFmpeg version (reproducible across dev/test/prod). `ffprobe` JSON output is a stable, documented interface. Argument arrays avoid shell injection. The wrapper is ~100 LOC and fully testable against fixture files.
- **Cons:** We write the wrapper (process lifecycle, stderr capture, timeouts, exit-code mapping). The image grows by the FFmpeg package size.

### Option B: `fluent-ffmpeg`
- Fluent JS API over the ffmpeg CLI, with `ffprobe()` helper.
- **Pros:** Familiar API, many examples.
- **Cons:** **Deprecated and unmaintained** (last release May/2024). Still needs FFmpeg installed separately, so it saves no infra work. Its abstractions leak for anything non-trivial.

### Option C: `ffmpeg-static` / `ffprobe-static` npm binaries + `spawn`
- npm packages download prebuilt static binaries at install time.
- **Pros:** No Dockerfile change; works on a dev host without FFmpeg.
- **Cons:** Install-time binary downloads (platform-specific, can break in CI or behind proxies). Binary versions are tied to package releases. Duplicates what the container already controls. All npm commands run in Docker anyway, so the host-portability benefit does not apply.

**Recommendation:** **Option A (system FFmpeg in the image + typed `spawn` wrapper)**. The project already runs everything in containers, so the image is the natural place to pin FFmpeg. `ffprobe -print_format json` is a better contract than any wrapper's object model, and B is ruled out by deprecation.

**Decision:** **Option B: `fluent-ffmpeg`**
**Libraries:** fluent-ffmpeg, @types/fluent-ffmpeg

**Revisions:**
- 2026-10-10 — Rationale for choosing B over the recommendation, and mitigations. Rationale: a familiar, widely
  documented API (`ffprobe()` helper, chained input/output options, `screenshots`/filters) shortens the worker's
  implementation and keeps FFmpeg command assembly readable; the package is a thin CLI wrapper, so its deprecation
  does not change FFmpeg's behavior. Mitigations: exact pin `fluent-ffmpeg@2.1.3` + `@types/fluent-ffmpeg`;
  ffmpeg/ffprobe installed from the OS package manager in the worker image (version controlled by the image, not
  by npm); all usage confined to a single `FfmpegService` with typed results, so replacing it with Option A later
  touches only that service, never the processor.
- 2026-10-10 — `**Libraries:**` field filled with `fluent-ffmpeg` (exact pin 2.1.3, per the revision above) and
  `@types/fluent-ffmpeg`. Rationale: resolves validation IC-3 — the empty field kept these dependencies out of
  library-refs.md and doc lookups. Decision B unchanged.

---

## TD-09: Worker Access to the Source File

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The source object can be 10GB. FFmpeg can read inputs over HTTP using range requests, so `ffprobe` usually reads only the container header/index, and a seek for a thumbnail reads only around the target timestamp. Some MP4s store the `moov` index at the end, which still works over HTTP via an extra range read. Full reads are only needed when TD-10 requires remux/transcode. Depends on TD-10 and TD-08.

**Options:**

### Option A: Always read via presigned GET URL (HTTP range input)
- The worker presigns a short-lived GET (internal endpoint) and passes the URL as FFmpeg input for every operation, including remux/transcode, with output to a temp file that is then uploaded.
- **Pros:** No 10GB local copy. Probe and thumbnail are fast regardless of file size.
- **Cons:** Remux/transcode over HTTP reads the whole object anyway, and a network hiccup mid-transcode fails the job (FFmpeg reconnect flags mitigate this).

### Option B: Always download the full object to a temp volume first
- `GetObject` stream → local file → FFmpeg on local disk → delete.
- **Pros:** Simplest FFmpeg invocation; local seeks are cheapest; no reconnect concerns.
- **Cons:** **10GB of disk and transfer for every video, even when only probing.** Needs a sized scratch volume in Compose. Slower time-to-ready for the common case.

### Option C: Hybrid — probe and thumbnail via URL; download only when TD-10 requires a full rewrite
- Probe and thumbnail use the presigned URL (Option A behavior). Remux/transcode downloads to a temp volume first (Option B behavior), or streams input from the URL if the team prefers.
- **Pros:** The cheap operations stay cheap, and the expensive operation gets the robust local-disk path. Disk is only used when the job genuinely needs the whole file.
- **Cons:** Two input modes in the wrapper. A scratch volume is still needed for the rewrite path.

**Recommendation:** **Option C (hybrid)**. Metadata extraction and thumbnail generation are needed for every video and touch only a few MB over HTTP range reads. Only the TD-10 normalization path needs the full file, and local disk is the more reliable input for a multi-minute job. If TD-10 picks Option A (no rewrite), this collapses to Option A.

**Decision:** **Option C: Hybrid — probe and thumbnail via URL; download only when TD-10 requires a full rewrite**

---

## TD-10: Streaming Delivery Format

**Scope:** Cross-layer

**Capability:** Reprodução via streaming (sem necessidade de download completo)

**Context:** "Streaming without full download" can be satisfied by progressive HTTP range playback of an MP4/WebM (the browser's `<video>` fetches ranges) or by adaptive streaming (HLS/DASH). Uploaded files can be anything (MOV/HEVC from phones, MKV, AVI), and many are not playable in all browsers. MP4s with `moov` at the end start slower. Backend impact: what the worker produces and stores. Frontend impact (Phase 05 player): a plain `<video src>` vs. an HLS player library (`hls.js`). Choosing here constrains Phase 05.

**Options:**

### Option A: Serve the original as-is, restrict accepted formats
- Accept only browser-playable containers/codecs (MP4 H.264/AAC, WebM VP9/Opus). The worker validates codecs via `ffprobe` and marks the rest `failed`. The original object is the playback source.
- **Pros:** Zero CPU beyond probing. One stored object per video. Simplest.
- **Cons:** **Rejects common uploads** (iPhone HEVC `.mov`, MKV), which is a poor UX for a YouTube-like product. `moov`-at-end files start slower. No control over bitrate (a 10GB file streams at its own bitrate).

### Option B: Normalize to a single web-playable MP4 (H.264/AAC, `+faststart`)
- The worker produces `playback.mp4`: **remux** (`-c copy -movflags +faststart`, fast and cheap) when codecs are already H.264/AAC; **transcode** to H.264/AAC otherwise. The original is kept for download (TD-11) or discarded per policy. Playback is progressive via range requests.
- **Pros:** **Every upload becomes playable** in every browser with a plain `<video>` (no player lib in Phase 05). Fast start guaranteed. The common case (phone/camera H.264 MP4) is a seconds-long remux.
- **Cons:** Transcode of non-H.264 sources is CPU-heavy (minutes per long video; acceptable on the isolated worker, TD-03). Up to 2× storage if the original is kept. No adaptive bitrate.

### Option C: HLS adaptive streaming (multi-rendition transcode)
- The worker transcodes to several renditions (e.g., 1080p/720p/480p) segmented as HLS. Phase 05 uses `hls.js` (Safari plays natively).
- **Pros:** Adaptive bitrate, the YouTube-like experience; best on slow networks.
- **Cons:** **Most CPU and storage** (N renditions per video). Many objects per video, which complicates presigned delivery (TD-11): playlists reference segments, so signing needs per-segment URLs or cookie/prefix signing. Adds a player library to Phase 05. Far beyond the phase's "extração de duração e metadados" processing scope.

**Recommendation:** **Option B (normalize to a single faststart H.264/AAC MP4)**. It satisfies streaming playback for every upload with a plain `<video>` element and a single object per video, which keeps TD-11's presigned delivery simple. Its cost is low in the common case (remux). Option A rejects too many real uploads; Option C is the right future upgrade (it can be layered on later from the kept original) but is disproportionate now.

**Decision:** **Option B (normalize to a single faststart H.264/AAC MP4)**

**Revisions:**
- 2026-10-10 — The original upload is **kept** alongside `playback.mp4`: the original is the download source
  (TD-11) and the input for any future HLS upgrade (Option C); `playback.mp4` is the only streaming source.
  Rationale: the "kept or discarded per policy" point was open, and download fidelity to the uploaded file is the
  expected behavior for "Download do vídeo pelo usuário".

---

## TD-11: Media Delivery Path and URL Signing (Streaming + Download)

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário", "Serviço de armazenamento de arquivos (vídeos e thumbnails)"

**Context:** The browser must fetch video bytes (range requests for playback; a full download with a sensible filename) and thumbnails (rendered in many grids from Phase 04/07 onward). Phase 04 introduces drafts and unlisted videos that must not be reachable by guessable or permanent URLs. Under the strict BFF, the API hands URLs to the FE through Route Handlers, and the bytes then flow browser ↔ storage directly (as in the C4 diagram). **Networking contract:** presigned URLs embed the signed host, so the API needs a storage endpoint for its own calls (Compose service name) and a browser-reachable public endpoint for signing (e.g., `S3_ENDPOINT` vs `S3_PUBLIC_ENDPOINT`). This must line up across Joi, `compose.yaml` and `.env.example`, and the FE needs the public host for `next/image` `remotePatterns`. Depends on TD-01 and TD-10.

**Options:**

### Option A: Everything private; presigned GET URLs for videos and thumbnails
- The API returns short-lived presigned URLs for playback, download (with `ResponseContentDisposition=attachment; filename=...`) and every thumbnail.
- **Pros:** Uniform; nothing is ever publicly readable; access is decided per request.
- **Cons:** Thumbnail URLs change on every response, which **defeats browser/`next/image` caching** in grids. Signing dozens of URLs per listing page is cheap CPU but noisy. URLs expire while a page stays open.

### Option B: Public-read bucket with unguessable keys
- Media lives under random keys; the API returns stable public URLs.
- **Pros:** Simplest; fully cacheable; no signing.
- **Cons:** **A leaked URL is valid forever.** Drafts and unlisted videos (Phase 04/05) cannot be revoked or gated. Download filenames cannot be controlled per request.

### Option C: Proxy bytes through the API/BFF with range support
- `GET /videos/:id/stream` in Nest (and a BFF passthrough) pipes ranges from storage.
- **Pros:** Full access control on every byte; storage stays completely private; no CORS.
- **Cons:** **Every byte of every view crosses Next and Nest**, which contradicts the phase's performance goal and the C4 diagram's direct `Frontend → Object Storage` stream.

### Option D: Hybrid — private videos via short-lived presigned URLs; thumbnails under a public-read prefix
- Videos (`playback.mp4`, original) are private. The API issues presigned GETs per request (playback with a short TTL; download with `attachment` disposition). Thumbnails live under a public-read prefix with content-addressed or versioned keys, so their URLs are stable and cacheable.
- **Pros:** **Access control where it matters** (video bytes for drafts/unlisted) and **cacheability where it matters** (thumbnail grids). Bytes never cross the API. Download filenames are controlled per request.
- **Cons:** Two access policies to configure (bucket policy for the thumbnail prefix). Thumbnails of unlisted/draft videos are public by URL (acceptable: unguessable, and a thumbnail alone is low-sensitivity). Presigned TTL must cover a viewing session, or the player re-requests a URL on expiry.

**Recommendation:** **Option D (hybrid)**. Protecting video bytes for drafts and unlisted videos is a hard requirement of Phases 04–05, and thumbnail cacheability is a hard performance need for every listing page; D is the only option that gets both without routing bytes through the API. The `S3_ENDPOINT`/`S3_PUBLIC_ENDPOINT` split (or equivalent names) is part of this decision because it is the cross-component contract that makes presigned URLs work from the browser in Docker.

**Decision:** **Option D: Hybrid — private videos via short-lived presigned URLs; thumbnails under a public-read prefix**

**Revisions:**
- 2026-10-10 — Phase 03 access scope and streaming semantics made explicit. In Phase 03 every video is a draft
  (TD-05), so playback and download URLs are issued **only to the authenticated owner of the channel**; anonymous
  access is introduced in Phase 05. Playback URL → `playback.mp4` (only when `processing_status = ready`); download
  URL → the original with `ResponseContentDisposition=attachment; filename="<title>.<ext>"`. Streaming relies on
  HTTP Range against the presigned GET: MinIO/S3 answer `Range: bytes=…` with `206 Partial Content`, which is how
  the brief's "sem exigir download completo" is satisfied and verified. Rationale: the brief names Range/206
  explicitly and Phase 03 had no stated access rule for draft media.

---

## TD-12: Unique Public Video ID (URL Identifier)

**Scope:** Cross-layer

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Each video needs a short, unique, non-conflicting URL (project-plan § Pontos de Atenção: "URL curta e única"). Existing entities use `uuid` primary keys. Backend impact: column, generation, lookup endpoints (`GET /videos/:publicId`). Frontend impact: route segment shape (e.g., `/watch/[id]`), link building, validation of the param. Unlisted videos (Phase 05) rely on the ID being **unguessable**.

**Options:**

### Option A: Random 11-char base64url ID in a `public_id` column (UNIQUE), retry on collision
- Generated with `crypto.randomBytes(8)` encoded as base64url (≈64 bits, 11 chars, YouTube-like), or `nanoid` with a custom alphabet. The UNIQUE constraint makes collisions impossible to persist; insert retries on the (astronomically rare) conflict. The UUID PK stays internal.
- **Pros:** Short, URL-safe, **not enumerable** (good for unlisted). No new dependency with `node:crypto`. The DB constraint is the uniqueness guarantee, so there is no coordination logic.
- **Cons:** One extra indexed column. IDs carry no ordering (irrelevant for URLs).

### Option B: Use the existing UUID PK in the URL
- **Pros:** Zero extra work; already unique and unguessable.
- **Cons:** **36-char URLs**, which fails the "URL curta" requirement and is unfriendly to share. Exposes the internal PK.

### Option C: Sqids/Hashids-encoded integer sequence
- Encode a `bigint` sequence into a short string with a secret alphabet.
- **Pros:** Very short IDs; deterministic; no collision handling.
- **Cons:** **Encodings are reversible and enumerable** (sequential underneath), which is unsuitable for unlisted videos. Requires a second sequence-based key alongside the UUID PK. A new dependency.

**Recommendation:** **Option A (random 11-char base64url `public_id` with UNIQUE constraint)**. It meets "curta e única" with the database as the uniqueness authority, keeps IDs unguessable for Phase 05's unlisted links, and needs no dependency. The alphabet/length is the contract the FE route validates.

**Decision:** **Option A: Random 11-char base64url ID in a `public_id` column (UNIQUE), retry on collision**

---

## TD-13: Thumbnail Generation Policy

**Scope:** Backend

**Capability:** Geração automática de thumbnail a partir de um frame do vídeo

**Context:** The worker generates one automatic thumbnail per video. Frame choice affects quality (black intro frames and fades are common at t=0) and cost (decoding many frames of a large file over HTTP is expensive, TD-09). Phase 04 adds custom thumbnails, which replace this one. Output format/size is consumed by the FE via `next/image` (TD-11 public prefix).

**Options:**

### Option A: Single frame at a fixed offset
- Input-seek (`-ss` before `-i`) to ~10% of the duration (clamped for very short videos) and grab one frame.
- **Pros:** Cheapest: one seek, one decode. Deterministic.
- **Cons:** Can land on a black/transition frame.

### Option B: Seek to an offset, then let FFmpeg's `thumbnail` filter pick the most representative frame from a short window
- `-ss <10%> -i <src> -vf "thumbnail=N,scale=1280:-2" -frames:v 1`: decodes N frames (e.g., ~100, a few seconds) after the seek and picks the one closest to the window's average histogram.
- **Pros:** Avoids black/fade frames in most cases at bounded cost (a few seconds of decoding, independent of file size).
- **Cons:** Slightly more CPU than A; still heuristic.

### Option C: Multiple candidates (e.g., 25/50/75%), store all, default to one
- **Pros:** Lets a future UI offer "choose a thumbnail".
- **Cons:** 3× work and storage. Phase 04's capability is a *custom upload*, not choosing among candidates, so this is extrapolation.

**Recommendation:** **Option B (seek + `thumbnail` filter over a short window)**. It fixes the most visible quality failure of A for a few seconds of decoding per video and stays independent of file size. Output as JPEG at 1280px width (`scale=1280:-2`); the exact quality setting is an implementation parameter.

**Decision:** **Option B: Seek to an offset, then let FFmpeg's `thumbnail` filter pick the most representative frame from a short window**

---

## TD-14: Processing Status Propagation to the Frontend

**Scope:** Cross-layer

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** After upload completes, the user waits seconds to minutes for processing (TD-10) before the video is `ready`. The FE must reflect `processing → ready | failed` without a manual reload. Backend impact: what endpoint/transport exposes status. Frontend impact: how the upload screen subscribes, under the strict BFF (all traffic via `app/api/**`) and the MSW-based test pattern (`next-frontend-msw-foundation/*`).

**Options:**

### Option A: Polling through the BFF
- The FE polls `GET /api/videos/:id` (→ Nest `GET /videos/:id`) every few seconds while `processing_status ∈ { uploading, processing }`, stopping on `ready`/`failed`.
- **Pros:** **No new transport**: plain REST through the existing BFF. Trivially testable with MSW (sequence of fixture responses). Works across reloads and tabs. Status changes take minutes, so a few seconds of latency is irrelevant.
- **Cons:** Some redundant requests while processing (bounded: one video, minutes).

### Option B: Server-Sent Events relayed through a Route Handler
- Nest exposes `@Sse()` per video (fed by queue events); a Next Route Handler streams it to the browser.
- **Pros:** Push updates, no redundant requests; can stream progress percentages.
- **Cons:** **Long-lived streams through two hops** (Next → Nest), plus queue-event fan-out from worker to API (Redis pub/sub or BullMQ `QueueEvents`). Harder to test with the current MSW pattern. Reconnect handling is needed. Complexity out of proportion for a minutes-long, once-per-upload wait.

### Option C: WebSocket (Socket.IO gateway)
- **Pros:** Bidirectional; reusable for future real-time features.
- **Cons:** Route Handlers cannot proxy WebSockets, so the browser would connect to Nest directly, **breaking the strict BFF**. New gateway and auth handshake. Dominated by A for this need.

**Recommendation:** **Option A (polling via BFF)**. It fits the strict BFF and the existing test scaffold without new infrastructure, and the latency of polling is irrelevant for a process measured in minutes. If a later phase needs real-time push (e.g., live comment counters), B can be introduced then with its own TD.

**Decision:** **Option A (polling via BFF)**

---

## TD-15: Processing Failure Policy

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** The challenge brief explicitly requires deciding "o ciclo de status do vídeo e o que acontece em caso de falha no processamento". Processing (TD-08/09/10/13) can fail transiently (storage hiccup, worker restart, FFmpeg crash under load) or permanently (the file is not a video, codecs FFmpeg cannot decode). The outcome must end in a terminal `processing_status` (TD-05) with a reason the owner (and later the Phase 04 panel) can read. Depends on TD-02 (BullMQ retry primitives) and TD-05.

**Options:**

### Option A: Bounded retries with backoff, permanent errors fail fast, `failed` + reason
- Jobs run with 3 attempts and exponential backoff. Errors classified as permanent (ffprobe finds no video stream / unreadable container / unsupported input) throw BullMQ's `UnrecoverableError`, skipping retries. When attempts are exhausted (including stalled jobs from a crashed worker), a `failed` handler sets `processing_status = failed` and a machine-readable `failure_reason`. The original object is kept.
- **Pros:** Transient failures self-heal; garbage uploads do not burn retries. Terminal state is always reached. Uses only built-in BullMQ features.
- **Cons:** Needs an error-classification step in the processor. Partial outputs (thumbnail written, playback not) must be cleaned or overwritten idempotently on retry.

### Option B: Fail on first error
- Any exception sets `failed` immediately (attempts = 1).
- **Pros:** Simplest; no idempotency concerns across attempts.
- **Cons:** A single network blip or worker restart permanently fails a valid 10GB upload, forcing a full re-upload.

### Option C: Option A + owner-triggered reprocessing endpoint
- Adds `POST /videos/:id/reprocess` for `failed` videos.
- **Pros:** Recovery without re-upload after a fix.
- **Cons:** No Phase 03 capability asks for it (extrapolation); adds an endpoint, authorization and state rules.

**Recommendation:** **Option A**. It guarantees the brief's terminal states (pronto/erro) are always reached, tolerates the transient failures typical of a long-running job over a 10GB object, and avoids wasting retries on inputs that can never succeed — all with native BullMQ primitives (TD-02). Reprocessing (C) can be added in a later phase if needed.

**Decision:** **Option A (bounded retries + fail-fast permanent errors + `failed` with reason)** — accepted by the user on 2026-10-10.

---

## TD-16: Stale-Upload Sweep Mechanism and Host Process

**Scope:** Backend

**Capability:** Transversal — covers: "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Serviço de processamento em segundo plano (filas)"

**Context:** The TD-07 Revision fixes the policy *"periodic sweep marks videos still `uploading` after 24 h as `failed`"*. It does not say how the sweep is triggered or which process runs it, so `plan-validate` raised MD-1. The choice matters for three reasons. It may add a library (`@nestjs/schedule` is not installed; `bullmq`/`@nestjs/bullmq` arrive with TD-02). It decides whether the sweep runs once or once per replica (TD-03 lets workers scale, and the API may scale too). It also decides whether the DB visibly holds the terminal state, which the TD-05 Revision requires for the brief's status cycle. The sweep races the TD-06 B event consumer (an upload finishing near the 24 h mark), so both transitions out of `uploading` must be conditional (`UPDATE … WHERE processing_status = 'uploading'`). That holds for every option below. Incomplete multipart parts are already cleaned by the bucket lifecycle rule (TD-07), so the sweep only owns the DB row. Depends on TD-02, TD-03, TD-05, TD-06, TD-07.

**Options:**

### Option A: BullMQ Job Scheduler on a dedicated maintenance queue, processed by the video worker
- The worker (TD-03) calls `queue.upsertJobScheduler('stale-upload-sweep', { every: <interval> }, { name: 'sweep-stale-uploads' })` at bootstrap. A `@Processor('maintenance')` in `WorkerModule` runs one conditional bulk `UPDATE` setting `processing_status = failed` and `failure_reason = upload_expired` (TD-15 shape). It uses its own queue, separate from video processing.
- **Pros:** No new dependency; it reuses TD-02's Redis and `@nestjs/bullmq`. Runs **once per tick regardless of replica count**, because the scheduler is a single Redis entity and `upsert` is idempotent across workers restarting. Keeps background work out of the API process (TD-03's rationale). Gets BullMQ retries and visibility for free. A dedicated queue avoids the documented caveat that a scheduler only produces its next job once the previous one starts processing, so it cannot starve behind multi-minute FFmpeg jobs.
- **Cons:** The schedule lives in Redis, not in code. Renaming or removing it needs an explicit `removeJobScheduler`, and changing the interval relies on the bootstrap upsert. Integration tests need real Redis (already true for TD-02). A second queue name to configure.

### Option B: `@nestjs/schedule` `@Cron` + `@nestjs/locks` `@OnOneInstance`
- `ScheduleModule.forRoot()` with an `@Cron(EVERY_HOUR)` method, in the API or the worker, runs the same conditional `UPDATE`. Per the NestJS docs, the scheduler runs every job in every process, so `@OnOneInstance` with a shared lock store (Redis or PostgreSQL) is needed to run it once per tick.
- **Pros:** Declarative, and the schedule is visible in code. Idiomatic NestJS. Independent of queue state.
- **Cons:** Adds **two** dependencies (`@nestjs/schedule`, `@nestjs/locks`) plus a lock store configuration, which duplicates the scheduling and coordination BullMQ already provides. Without the lock it silently runs N times with N replicas. Tests must drive the cron tick or call the method directly.

### Option C: No scheduler — lazy expiration at read time
- Treat `uploading` older than 24 h as failed when read (computed in queries/serialization), optionally persisting `failed` when the row is touched (status poll, `complete`, event consumer).
- **Pros:** Zero scheduling infrastructure and no extra process work.
- **Cons:** **The DB does not hold the terminal state** for untouched rows, which conflicts with the TD-05 Revision ("o ciclo deve ser refletido no banco"). Every query that filters by status (Phase 04 panel, listings) must reapply the rule, so it spreads across components and drifts. Also contradicts the TD-07 Revision's "periodic sweep" wording.

**Recommendation:** **Option A (BullMQ Job Scheduler, dedicated `maintenance` queue, processed in the video worker)**. TD-02 already puts BullMQ and Redis in the stack and TD-03 already gives background work its own process. A Job Scheduler gets exactly-once-per-tick execution across replicas with no new library, while Option B needs two extra packages and a lock store to match it. Option C does not meet the TD-05 Revision's requirement that the DB show the terminal state. Suggested parameters, to be fixed at decision time or by `/plan-build`: interval `every: 1 h` (worst case ≈ 25 h before a stale upload is marked), `failure_reason = upload_expired`.

**Decision:** **Option A (BullMQ Job Scheduler, dedicated `maintenance` queue, processed in the video worker)**

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|----------------|--------|
| TD-01 | Backend | Object storage server (dev/test) and access SDK | **A** (MinIO pinned, dev-only; AWS SDK v3) | **A** |
| TD-02 | Backend | Background job queue technology | **A** (BullMQ + Redis via `@nestjs/bullmq`) | **A** |
| TD-03 | Backend | Video worker topology | **A** (separate container, same codebase, second entrypoint) | **A** |
| TD-04 | Cross-layer | Upload protocol for ≤10GB resumable uploads | **A** (S3 multipart, presigned parts, API-mediated control plane) | **A** |
| TD-05 | Cross-layer | Video lifecycle status modeling | **B** (processing status + publication state as separate fields) | **B** |
| TD-06 | Backend | Upload completion signal and job trigger | **A** (client-driven `complete` call, idempotent enqueue) | **B** — see Revisions |
| TD-07 | Cross-layer | Upload validation and limits policy | **A** (declare-and-verify, server-dictated part size, ffprobe authority, lifecycle cleanup) | **A** |
| TD-08 | Backend | FFmpeg integration approach | **A** (system FFmpeg in image + typed `spawn` wrapper) | **B** — see Revisions |
| TD-09 | Backend | Worker access to the source file | **C** (hybrid: URL for probe/thumbnail, download for rewrite) | **C** |
| TD-10 | Cross-layer | Streaming delivery format | **B** (normalize to faststart H.264/AAC MP4) | **B** |
| TD-11 | Cross-layer | Media delivery path and URL signing | **D** (private videos via presigned; public-read thumbnail prefix) | **D** |
| TD-12 | Cross-layer | Unique public video ID | **A** (random 11-char base64url `public_id`, UNIQUE) | **A** |
| TD-13 | Backend | Thumbnail generation policy | **B** (seek + `thumbnail` filter window, JPEG 1280px) | **B** |
| TD-14 | Cross-layer | Processing status propagation | **A** (polling via BFF) | **A** |
| TD-15 | Backend | Processing failure policy | **A** (3 attempts + backoff, `UnrecoverableError` for permanent errors, `failed` + `failure_reason`) | **A** |
| TD-16 | Backend | Stale-upload sweep mechanism and host process | **A** (BullMQ Job Scheduler on a `maintenance` queue, processed by the video worker) | **A** |

---

## Notes for downstream pipeline

- **Scope.** This is the single decisions doc for Phase 03 (`scope_type: phase`, no `covers_capabilities`). Per the challenge brief, Phase 03 is backend-only: no frontend slice is planned for this phase. Upload/streaming are exercised by backend e2e/integration tests that act as the client (presigned PUT/GET against the real storage container).
- **FE hand-off (Phases 04/05).** When the frontend consumes these contracts, it inherits TD-04/05/07/10/11/12/14 as constraints and must decide at least:
  - the upload client library (Uppy 6 `@uppy/aws-s3` vs custom multipart uploader — must respect TD-04's server-mediated Create/Complete);
  - resume after page reload (Uppy Golden Retriever or equivalent; `File` handles are lost on reload, so the user must re-select the file);
  - progress/status UI;
  - the BFF Route Handlers for the upload control plane;
  - `next/image` `remotePatterns` for the thumbnail host (TD-11);
  - **the E2E strategy for browser→storage traffic.** Today's E2E rule fakes only upstream NestJS via server-side MSW, and direct PUTs to storage are not covered by that mechanism.
- **Dependencies between TDs:** TD-04 → TD-06, TD-07 (API-mediated multipart; under TD-06 B the size check lives in the event consumer — see TD-06/TD-07 Revisions). TD-02 + TD-05 → TD-15. TD-10 → TD-09 (if TD-10 = A, TD-09 collapses to A). TD-01 + TD-10 → TD-11. TD-02 → TD-03 (processor shape). TD-05 → TD-14 (polling stop condition). TD-02 + TD-03 + TD-07 → TD-16 (sweep mechanism; transition out of `uploading` must be conditional because it races the TD-06 B consumer).
- **Testing guide revision required.** _Done 2026-10-10 (PR #1): the guide now covers MinIO via the S3 API and BullMQ on real Redis, plus `artifacts/processors.md`._ Original note: `.claude/skills/testing-guide-nestjs-project/references/external-systems.md` § "Object Storage — Local Filesystem" contradicts TD-01 A/B/C + TD-04 A. If those are accepted, `/plan-build` must include a task to rewrite that section ("real S3-compatible server in Docker, bucket cleaned between tests") and to concretize the queue section with the TD-02 choice. Integration tests then hit the real storage and Redis containers, consistent with the existing real-DB + Mailpit approach.
- **New env keys (cross-component contract).** Storage (`S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, bucket name(s)) queue (`REDIS_HOST`, `REDIS_PORT`) and storage-event webhook (a shared token, e.g. `STORAGE_WEBHOOK_TOKEN`, per TD-06 Revision) keys go into `env.validation.ts` (Joi), new `registerAs` namespaces, `compose.yaml` and `.env.example`. Exact names are an implementation detail; the internal-vs-public endpoint split is part of TD-11. Per root `CLAUDE.md`, internal hosts use Compose service names; only `S3_PUBLIC_ENDPOINT` is a host-reachable URL (published port), because the browser consumes it.
- **Compose topology.** `nestjs-project/compose.yaml` gains the storage service (+ init step for bucket, CORS, lifecycle, the public-read thumbnail prefix policy and the `notify_webhook` target pointing at the API by service name — TD-06 Revision), `redis` (TD-02 A) and `video-worker` (TD-03 A). The `next-frontend` stack stays separate; the browser reaches storage through the published host port.
- **Bucket CORS** must allow the FE origin (`http://localhost:3001` in dev), the methods `PUT`/`GET`/`HEAD`, and expose `ETag` (required by TD-04 A for multipart completion).
- **Phase 04 hand-off.** TD-05 B leaves the publication field defaulting to draft with no transitions; Phase 04 owns publish/visibility. TD-13's automatic thumbnail is replaced by Phase 04's custom thumbnail upload, which can reuse TD-11's public thumbnail prefix.
- **Streaming verification.** TD-11 Revision: backend e2e verifies streaming by requesting the playback presigned URL with `Range: bytes=0-1023` and asserting `206 Partial Content`.
- **Phase 05 hand-off.** TD-10 B means a plain `<video src={presignedUrl}>` player. TD-11 D means the watch page requests a fresh presigned URL per view. TD-12's `public_id` is the watch-route identifier.

Sources consulted during research:

- [BullMQ documentation](https://docs.bullmq.io/) — NestJS integration (`BullModule.forRoot/registerQueue`, `@Processor` + `WorkerHost`), retries/backoff, sandboxed/separate-process workers.
- [pkgpulse — BullMQ vs Bee-Queue vs pg-boss (2026)](https://www.pkgpulse.com/guides/bullmq-vs-bee-queue-vs-pg-boss-job-queues-nodejs-2026) and [Wasp — interview with pg-boss author](https://wasp.sh/blog/2024/09/03/OS-builders-interview-with-tim-jones-pgboss) — pg-boss trade-offs, v10 partitioned queues.
- [Uppy — AWS S3 plugin](https://uppy.io/docs/aws-s3), [Uppy migration guides](https://uppy.io/docs/guides/migration-guides), [Uppy 6.0 release](https://uppy.io/blog/uppy-6.0/), [Golden Retriever](https://uppy.io/docs/golden-retriever) — `signRequest` rewrite, multipart threshold, resume-after-reload.
- [AWS SDK for JavaScript v3 — `@aws-sdk/s3-request-presigner`](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/Package/-aws-sdk-s3-request-presigner) and [UploadPartCommand](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/s3/command/UploadPartCommand) — presigned part/GET URLs, `forcePathStyle`.
- [tus Node.js server v2.0.0](https://tus.io/blog/2025/03/25/tus-node-server-v200) and [`@tus/s3-store`](https://www.npmjs.org/package/@tus/s3-store) — tus server packages and S3 store part-size limits.
- MinIO status: [linuxiac — MinIO ends active development](https://linuxiac.com/minio-ends-active-development/), [glukhov — MinIO CE in 2026](https://glukhov.org/data-infrastructure/object-storage/minio-dead/), [Chainguard — free MinIO containers](https://www.chainguard.dev/fr-FR/unchained/secure-and-free-minio-chainguard-containers), [ragflow issue #13840](https://github.com/infiniflow/ragflow/issues/13840). These are secondary sources; exact dates should be checked against the MinIO repository.
- Alternatives: [glukhov — self-hosted S3 alternatives 2026](https://glukhov.org/data-infrastructure/object-storage/self-hosted-s3-alternatives/), [Elestio — RustFS vs SeaweedFS vs Garage](https://blog.elest.io/rustfs-vs-seaweedfs-vs-garage-which-minio-alternative-should-you-pick/).
- [`fluent-ffmpeg` on npm](https://npmjs.com/package/fluent-ffmpeg) — deprecation notice.
- Project sources: `docs/project-plan.md` (Fase 03 + Pontos de Atenção), `docs/diagrams/software-arch.mermaid`, `nestjs-project/{package.json,compose.yaml,Dockerfile.dev,CLAUDE.md}`, `next-frontend/CLAUDE.md`, `.claude/skills/testing-guide-nestjs-project/references/external-systems.md`, and the decided TDs in `docs/decisions/`.
