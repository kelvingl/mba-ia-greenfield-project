---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-10-07T22:40:21-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-10T14:07:05-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-10-10T13:49:26-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-10-07T22:40:21-03:00"
  docs/decisions/technical-decisions-next-frontend-config-base.md: "2026-10-07T22:40:21-03:00"
  docs/decisions/technical-decisions-next-frontend-msw-foundation.md: "2026-10-07T22:40:21-03:00"
  docs/decisions/technical-decisions-next-frontend-openapi-typing.md: "2026-10-07T22:40:21-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-10-07T22:40:21-03:00"
  docs/phases/phase-02-auth/context.md: "2026-10-07T22:40:21-03:00"
  docs/phases/phase-02-auth-frontend/context.md: "2026-10-07T22:40:21-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-10-10T13:49:26-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Upload e Processamento de Vídeos
**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** _Not specified._
**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.
**Affected subprojects:** _None named explicitly in the Phase 03 section._ It does not mention `nestjs-project`, `next-frontend` or any other subproject path.
**Deferred subprojects:** _None._
**Sequencing notes:** "> Depende de: Fase 01, Fase 02". Intro sentence: "Upload de arquivos grandes sem travar o sistema, processamento automático do vídeo e geração de URL única."

**Neighbors (for boundary detection only):**

- **Phase 02:** Cadastro, Login e Gerenciamento de Conta. "Fluxo completo de criação de conta, confirmação por e-mail, login, logout e recuperação de senha." (Depende de: Fase 01)
- **Phase 04:** Gerenciamento de Vídeos e Canal. "Edição das informações do vídeo, fluxo de rascunho e publicação, painel de administração do canal e página pública." (Depende de: Fase 02, Fase 03)

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | phase | Backend | Object Storage Server (dev/test) and Access SDK | decided | A (MinIO, pinned) | @aws-sdk/client-s3, @aws-sdk/s3-request-presigner |
|     └─ Last revision: 2026-10-10 — Aligned with the challenge brief (`docs/phases/phase-03-videos/enunciado.md`, "Sobre o… | | | | | | |
| phase-03-videos/TD-02 | phase | Backend | Background Job Queue Technology | decided | A (BullMQ + Redis) | bullmq, @nestjs/bullmq |
|     └─ Last revision: 2026-10-10 — `**Libraries:**` field filled with `bullmq` and `@nestjs/bullmq`, as the… | | | | | | |
| phase-03-videos/TD-03 | phase | Backend | Video Worker Topology | decided | A (separate container, same codebase, second entrypoint) | — |
| phase-03-videos/TD-04 | phase | Cross-layer | Upload Protocol for ≤10GB Resumable Uploads | decided | A (S3 multipart, presigned parts, API control plane) | — |
|     └─ Last revision: 2026-10-10 — Recommendation's completion rationale superseded: under TD-06 B the `complete`… | | | | | | |
| phase-03-videos/TD-05 | phase | Cross-layer | Video Lifecycle Status Modeling | decided | B (two orthogonal fields) | — |
|     └─ Last revision: 2026-10-10 — Explicit mapping to the challenge brief's status cycle ("rascunho → processando… | | | | | | |
| phase-03-videos/TD-06 | phase | Backend | Upload Completion Signal and Processing Job Trigger | decided | B (storage event notifications) | — |
|     └─ Last revision: 2026-10-10 — Rationale for choosing B over the recommendation, and the resulting mechanics | | | | | | |
| phase-03-videos/TD-07 | phase | Cross-layer | Upload Validation and Limits Policy | decided | A (declare-and-verify, server part size, worker final authority, storage cleanup) | — |
|     └─ Last revision: 2026-10-10 — Size verification moves from the `complete` endpoint to the TD-06 B event… | | | | | | |
| phase-03-videos/TD-08 | phase | Backend | FFmpeg Integration Approach | decided | B (`fluent-ffmpeg`) | fluent-ffmpeg, @types/fluent-ffmpeg |
|     └─ Last revision: 2026-10-10 — `**Libraries:**` field filled with `fluent-ffmpeg` (exact pin 2.1.3, per the… | | | | | | |
| phase-03-videos/TD-09 | phase | Backend | Worker Access to the Source File | decided | C (hybrid: probe/thumbnail via URL; download only for full rewrite) | — |
| phase-03-videos/TD-10 | phase | Cross-layer | Streaming Delivery Format | decided | B (single faststart H.264/AAC MP4) | — |
|     └─ Last revision: 2026-10-10 — The original upload is **kept** alongside `playback.mp4`: the original is the… | | | | | | |
| phase-03-videos/TD-11 | phase | Cross-layer | Media Delivery Path and URL Signing (Streaming + Download) | decided | D (hybrid: presigned URLs for videos; public-read thumbnails) | — |
|     └─ Last revision: 2026-10-10 — Phase 03 access scope and streaming semantics made explicit. In Phase 03 every… | | | | | | |
| phase-03-videos/TD-12 | phase | Cross-layer | Unique Public Video ID (URL Identifier) | decided | A (random 11-char base64url `public_id`, UNIQUE, retry on collision) | — |
| phase-03-videos/TD-13 | phase | Backend | Thumbnail Generation Policy | decided | B (seek offset + FFmpeg `thumbnail` filter) | — |
| phase-03-videos/TD-14 | phase | Cross-layer | Processing Status Propagation to the Frontend | decided | A (polling via BFF) | — |
| phase-03-videos/TD-15 | phase | Backend | Processing Failure Policy | decided | A (bounded retries + fail-fast permanent errors + `failed` with reason) | — |
| phase-03-videos/TD-16 | phase | Backend | Stale-Upload Sweep Mechanism and Host Process | decided | A (BullMQ Job Scheduler, `maintenance` queue, in video worker) | — |

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase, related_phases: [3])

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-01, phase-03-videos/TD-11 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-02, phase-03-videos/TD-03, phase-03-videos/TD-16 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-04, phase-03-videos/TD-06, phase-03-videos/TD-07, phase-03-videos/TD-16 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-05 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-03, phase-03-videos/TD-06, phase-03-videos/TD-08, phase-03-videos/TD-09, phase-03-videos/TD-14, phase-03-videos/TD-15 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-03, phase-03-videos/TD-08, phase-03-videos/TD-09, phase-03-videos/TD-13 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-12 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-10, phase-03-videos/TD-11 |
| Download do vídeo pelo usuário | phase-03-videos/TD-11 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** used strictly as a dev/test emulator, with the code bound only to the S3 API through the AWS SDK v3. Replacing the server later (with B, if MinIO's frozen state becomes a problem) is then a `compose.yaml` change, not a code change. MinIO gives the fastest path to a working presigned-multipart + CORS + lifecycle setup, and those are exactly the behaviors TD-04/07/11 depend on. Its abandonment is a real cost, but it is bounded because production is S3. Option B is the honest maintained alternative and becomes the recommendation if the team does not accept a frozen dev dependency. Option D is rejected because it cannot support direct-to-storage transfer. Choosing A, B or C requires revising the testing guide's storage section (see Notes).
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

### phase-03-videos/TD-02

**Recommendation:** The workload is job-shaped: long-running, retryable, with progress and per-job state the API may read back (TD-14). BullMQ models that natively, and `@nestjs/bullmq` gives the worker (TD-03) a first-party processor abstraction. Redis is a small, well-understood addition, and the testing guide already assumes it. Option B is a legitimate choice if the team prefers zero new infrastructure: its transactional enqueue is a real advantage, paid for with a hand-written integration. Option C buys routing flexibility the project does not need.
**Libraries:** bullmq, @nestjs/bullmq

**Revisions:**
- 2026-10-10 — `**Libraries:**` field filled with `bullmq` and `@nestjs/bullmq`, as the Recommendation names; the
  installed BullMQ major must provide Job Schedulers (`upsertJobScheduler`), which TD-16 relies on. Rationale: resolves
  validation IC-3 — the empty field kept these dependencies out of library-refs.md and doc lookups. Decision A unchanged.

### phase-03-videos/TD-03

**Recommendation:** It implements the C4 boundary and the performance requirement (processing is isolated from the API) while keeping a single owner of the `Video` entity and config, which matches the project's Single Responsibility principle without creating a second subproject. The FFmpeg-in-API-image cost is cosmetic in dev and can be removed later with a multi-stage build target.
**Libraries:** —

### phase-03-videos/TD-04

**Recommendation:** It is the only option where 10GB of bytes touch neither Next nor Nest without introducing a new public service, which satisfies both the performance capability and the strict BFF. Resume falls out of S3's own list-parts semantics. Keeping Create/Complete on the server is deliberate: the API learns about completion synchronously, which is the trigger for processing (TD-06) and the point where size validation happens (TD-07). The frontend doc must pick a client configuration that respects this; Uppy 6's `signRequest` mode moves Create/Complete to the client, so it either needs a server-mediated wrapper or a custom uploader.
**Libraries:** —

**Revisions:**
- 2026-10-10 — Recommendation's completion rationale superseded: under TD-06 B the `complete` endpoint only runs
  `CompleteMultipartUpload` and returns `202 Accepted`; the processing trigger and the size check live in the TD-06 B
  storage-event consumer (TD-07 Revision), not in `complete`. Rationale: aligned with the TD-06 B decision. Decision A
  (S3 multipart, presigned parts, API-mediated Create/Complete) unchanged.

### phase-03-videos/TD-05

**Recommendation:** The processing pipeline and the publication workflow are owned by different phases and change for different reasons. Separating them follows the project's Single Responsibility principle at the data-model level and spares Phase 04 from migrating an enum this phase created. The pre-registration capability is met by the publication field's draft default.
**Libraries:** —

**Revisions:**
- 2026-10-10 — Explicit mapping to the challenge brief's status cycle ("rascunho → processando → pronto/erro"):
  "rascunho" = `published_at IS NULL` (default at pre-registration) while `processing_status = uploading`;
  "processando" = `processing_status = processing`; "pronto/erro" = `processing_status = ready | failed`.
  `published_at` has no transitions in Phase 03 (owned by Phase 04). Rationale: the brief's acceptance criterion
  requires the cycle to be visibly reflected in the database; the two-axis model satisfies it and this entry makes
  the correspondence traceable.

### phase-03-videos/TD-06

**Recommendation:** Under TD-04 A the client must call complete anyway to finalize the multipart upload, so making that call also the processing trigger adds no new signal and is identical across storage servers. Idempotent enqueue (`jobId = videoId`) makes retried `complete` calls safe. Abandoned uploads are TD-07's job.
**Libraries:** —

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

### phase-03-videos/TD-07

**Recommendation:** It is the only option that enforces the 10GB capability on the server with direct uploads. It also makes the part size a server-owned contract value returned by the init endpoint, so the frontend doc does not need to re-decide it. The concrete values (part size, URL TTL, allowlist, lifecycle days) are parameters for `/plan-build`; the policy shape is what this TD fixes.
**Libraries:** —

**Revisions:**
- 2026-10-10 — Size verification moves from the `complete` endpoint to the TD-06 B event consumer (event `size` +
  `HeadObject`; oversize → object deleted, video `failed`). Concrete values fixed: max size 10 GiB
  (10 737 418 240 bytes); part size 64 MiB (≤160 parts); upload-part URL TTL 1 h; MIME allowlist `video/mp4`,
  `video/quicktime`, `video/webm`, `video/x-matroska`; bucket lifecycle `AbortIncompleteMultipartUpload` after 1 day;
  periodic sweep marks videos still `uploading` after 24 h as `failed`. Init accepts an optional `title`
  (1–100 chars), defaulting to the filename without extension (truncated to 100). Rationale: TD-06 changed the
  completion signal; the values were left to planning and the brief requires the persisted video to have a title.

### phase-03-videos/TD-08

**Recommendation:** The project already runs everything in containers, so the image is the natural place to pin FFmpeg. `ffprobe -print_format json` is a better contract than any wrapper's object model, and B is ruled out by deprecation.
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

### phase-03-videos/TD-09

**Recommendation:** Metadata extraction and thumbnail generation are needed for every video and touch only a few MB over HTTP range reads. Only the TD-10 normalization path needs the full file, and local disk is the more reliable input for a multi-minute job. If TD-10 picks Option A (no rewrite), this collapses to Option A.
**Libraries:** —

### phase-03-videos/TD-10

**Recommendation:** It satisfies streaming playback for every upload with a plain `<video>` element and a single object per video, which keeps TD-11's presigned delivery simple. Its cost is low in the common case (remux). Option A rejects too many real uploads; Option C is the right future upgrade (it can be layered on later from the kept original) but is disproportionate now.
**Libraries:** —

**Revisions:**
- 2026-10-10 — The original upload is **kept** alongside `playback.mp4`: the original is the download source
  (TD-11) and the input for any future HLS upgrade (Option C); `playback.mp4` is the only streaming source.
  Rationale: the "kept or discarded per policy" point was open, and download fidelity to the uploaded file is the
  expected behavior for "Download do vídeo pelo usuário".

### phase-03-videos/TD-11

**Recommendation:** Protecting video bytes for drafts and unlisted videos is a hard requirement of Phases 04–05, and thumbnail cacheability is a hard performance need for every listing page; D is the only option that gets both without routing bytes through the API. The `S3_ENDPOINT`/`S3_PUBLIC_ENDPOINT` split (or equivalent names) is part of this decision because it is the cross-component contract that makes presigned URLs work from the browser in Docker.
**Libraries:** —

**Revisions:**
- 2026-10-10 — Phase 03 access scope and streaming semantics made explicit. In Phase 03 every video is a draft
  (TD-05), so playback and download URLs are issued **only to the authenticated owner of the channel**; anonymous
  access is introduced in Phase 05. Playback URL → `playback.mp4` (only when `processing_status = ready`); download
  URL → the original with `ResponseContentDisposition=attachment; filename="<title>.<ext>"`. Streaming relies on
  HTTP Range against the presigned GET: MinIO/S3 answer `Range: bytes=…` with `206 Partial Content`, which is how
  the brief's "sem exigir download completo" is satisfied and verified. Rationale: the brief names Range/206
  explicitly and Phase 03 had no stated access rule for draft media.

### phase-03-videos/TD-12

**Recommendation:** It meets "curta e única" with the database as the uniqueness authority, keeps IDs unguessable for Phase 05's unlisted links, and needs no dependency. The alphabet/length is the contract the FE route validates.
**Libraries:** —

### phase-03-videos/TD-13

**Recommendation:** It fixes the most visible quality failure of A for a few seconds of decoding per video and stays independent of file size. Output as JPEG at 1280px width (`scale=1280:-2`); the exact quality setting is an implementation parameter.
**Libraries:** —

### phase-03-videos/TD-14

**Recommendation:** It fits the strict BFF and the existing test scaffold without new infrastructure, and the latency of polling is irrelevant for a process measured in minutes. If a later phase needs real-time push (e.g., live comment counters), B can be introduced then with its own TD.
**Libraries:** —

### phase-03-videos/TD-15

**Recommendation:** It guarantees the brief's terminal states (pronto/erro) are always reached, tolerates the transient failures typical of a long-running job over a 10GB object, and avoids wasting retries on inputs that can never succeed — all with native BullMQ primitives (TD-02). Reprocessing (C) can be added in a later phase if needed.
**Libraries:** —

### phase-03-videos/TD-16

**Recommendation:** TD-02 already puts BullMQ and Redis in the stack and TD-03 already gives background work its own process. A Job Scheduler gets exactly-once-per-tick execution across replicas with no new library, while Option B needs two extra packages and a lock store to match it. Option C does not meet the TD-05 Revision's requirement that the DB show the terminal state. Suggested parameters, to be fixed at decision time or by `/plan-build`: interval `every: 1 h` (worst case ≈ 25 h before a stale upload is marked), `failure_reason = upload_expired`.
**Libraries:** —

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem: the factory function can be imported as a plain function by `data-source.ts` while also serving as a DI injection token inside NestJS. Building a custom module recreates solved functionality; third-party packages carry maintenance risk.

**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, requiring zero custom wiring. Handles string-to-number coercion natively. Using a different tool for env validation vs. request validation is reasonable — env config is validated once at startup, DTOs are validated per-request. Zod is elegant but adds a third validation paradigm to the project.

**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — The project roadmap explicitly calls for auth, email, and storage in upcoming phases. Namespaced configs provide clear file boundaries per domain, typed injection via `ConfigType<typeof databaseConfig>`, and natural scalability. The `registerAs()` factory is dual-purpose: DI token inside NestJS and plain importable function for `data-source.ts`. Initial files for Phase 01: `src/config/database.config.ts`, `src/config/app.config.ts`.

**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Option A (Shared registerAs factory) — Natural outcome of choosing `@nestjs/config` with `registerAs`. The factory is already callable by design. `data-source.ts` imports it, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.

**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-01

**Recommendation:** Argon2id — For a greenfield project in 2026, Argon2id is the OWASP-recommended choice. The native build dependency is a one-time Docker setup cost. The project has no legacy constraints favoring bcrypt. OWASP minimum: 19MiB memory, 2 iterations.

**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** Option A (@nestjs/passport) — The project plan includes only email/password auth for now, but the plugin architecture costs little and future phases may add social login. Aligns with official NestJS docs, making onboarding and maintenance easier.

**Note:** Decision deliberately diverged from the Recommendation during implementation — custom guards were preferred over `@nestjs/passport` to keep the dependency surface smaller; social login is not on the near-term roadmap, so the plugin-architecture benefit did not justify the extra abstraction layer.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03

**Recommendation:** Option A (Refresh Token Rotation) — Provides the strongest security model with automatic theft detection. The DB write overhead is acceptable for a video platform (auth refresh is infrequent vs. video operations). PostgreSQL is already in the stack, so no new infrastructure needed. Race conditions can be mitigated with a short grace period for the old token.

**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Option B (Random Opaque Tokens in DB) — Revocability is important: when a user requests a new password reset, previous tokens should be invalidated. The DB table is trivial to implement, and the tokens table can also serve future needs (e.g., API keys). Keeps email tokens decoupled from the JWT auth system.

**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** Option A (@nestjs-modules/mailer) — Best NestJS integration with minimal boilerplate. Supports SMTP (matching the architecture diagram), works with MailHog/Mailpit for local development without external dependencies, and scales to any SMTP provider in production. Template engine support (Handlebars) simplifies email formatting. No vendor lock-in.

**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — This is a backend-only project (no shared schemas with frontend), so Zod's single-source-of-truth advantage is less impactful. class-validator is the documented NestJS approach, and the project already uses decorators extensively (TypeORM entities, NestJS DI). Fewer integration surprises with NestJS 11.

**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — Provides machine-readable error codes that the Next.js frontend can switch on, without the overhead of RFC 9457's URI-based type system. The project is single-consumer (first-party frontend), so a simple `{ statusCode, error, message }` format with domain codes balances clarity and simplicity. The custom filter cost is low — two small files.

**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Option A (@nestjs/throttler) — Native NestJS integration is decisive: the guard system allows scoping rate limiting to `AuthModule` only via module-level `APP_GUARD`, with `@SkipThrottle()` for exemptions. The project is single-instance with no distributed requirements, so in-memory storage is sufficient. Using express-rate-limit would bypass NestJS's DI and guard lifecycle for no clear benefit.

**Libraries:** `@nestjs/throttler@^6.x`

### phase-02-auth/TD-09

**Recommendation:** Option B (Opaque) — Since DB lookup is mandatory (TD-03), JWT signature adds no security value. Opaque tokens are shorter, leak no data, and are simpler to generate.

**Note:** Decision deliberately diverged from the Recommendation — JWT was kept to reuse the access-token signing/verification infrastructure (`@nestjs/jwt`), trading token size and base64-readability for a single token format across the codebase.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-10

**Recommendation:** Option A — The platform is a video sharing service with URL-based channel handles. A strict `[a-z0-9_]` allowlist is the simplest and most portable choice: no extra dependencies, no edge cases around hyphen positioning, and the `user_<random>` fallback provides a valid handle even for extreme email prefixes. Hyphens can always be added in a future iteration if user feedback justifies it.

**Libraries:** —

### phase-02-auth-frontend/TD-01

**Recommendation:** Three reasons. (1) **Architectural fit.** The strict-BFF model in `next-frontend-config-base/TD-03` already nominates the Route Handler as the only NestJS caller; cookie-based sessions are the natural match, and Auth.js's framework adds layers between the BFF and the cookie that buy nothing because the backend is the auth authority — Auth.js's value (DB adapters, OAuth providers, magic-link, `getServerSession` helpers) is mostly unused in this configuration. (2) **Smaller blast radius.** A ~50-LOC session helper is grep-friendly, debuggable, and test-friendly via the existing MSW+BFF integration test pattern; a misconfigured Auth.js callback is a longer fault-isolation loop. (3) **Compatibility with Next.js 16 / React 19.** Built-in `next/headers` `cookies()` is the canonical primitive both runtimes already use; Auth.js v5 versions track Next.js majors with a lag, adding compatibility risk that Option A does not have. Option C is rejected as unsafe (`localStorage` for refresh tokens) and architecturally regressive (loses RSC personalization).
**Libraries:** —

### phase-02-auth-frontend/TD-02

**Recommendation:** Three reasons. (1) **Defense in depth on the cookie content** — `httpOnly` blocks JS, encryption blocks accidental log/proxy inspection; the marginal cost is one ~3KB dep. (2) **Single cookie to manage** simplifies logout (one `session.destroy()` call) and avoids the orphan-cookie failure mode of Option A. (3) **Room to carry minimal user metadata** (`userId`, `email`, `channelSlug`) lets `app/layout.tsx` RSC render the authenticated chrome (avatar, channel name) without a per-render `/auth/me` round-trip — Phase 04+ gains compound here. Option A is a viable downgrade if the team rejects `iron-session` for any reason; the migration A→B (or B→A) is a one-Route-Handler refactor with no test changes downstream because the BFF interface is unchanged. Option C is rejected: it solves a problem (server-side revocation) the project does not have at the cost of infrastructure the project does not own.
**Libraries:** iron-session

### phase-02-auth-frontend/TD-03

**Recommendation:** The single-flight detail is non-trivial and goes in the helper from day one — tested by MSW with a "two concurrent intercepted upstream calls; one refresh expected" assertion. Option B's client-driven pattern is rejected because it doesn't replace Option A (RSC still needs server-side refresh) — adopting B means doing both. Option C's pre-emptive timer is rejected because the failure modes (multiple tabs, sleep/wake) outweigh the latency saving and force a `"use client"` shell near the root.
**Libraries:** —

### phase-02-auth-frontend/TD-04

**Recommendation:** Three reasons. (1) **Decoupled from TD-05** — works with Route Handlers OR Server Actions; the form code does not change if TD-05 is revisited later. (2) **Aligned with shadcn's canonical form primitive** — the project already commits to `radix-nova` shadcn (`components.json`); `npx shadcn@latest add form` produces react-hook-form wrappers; choosing react-hook-form means using the supported primitive instead of hand-rolling around it. (3) **Zod-first developer ergonomics match the rest of the FE foundation** — `next-frontend-config-base/TD-01` chose Zod 4 for env; the same schemas-as-source-of-truth pattern carries to forms with zero new validator paradigm. Option B is rejected for impedance with shadcn's primitive and for over-investing in progressive-enhancement that the strict-BFF model does not require. Option C is rejected for the per-field boilerplate and the loss of client-side feedback on a project that values quick, type-safe form iteration.
**Libraries:** react-hook-form, @hookform/resolvers

### phase-02-auth-frontend/TD-05

**Recommendation:** Three reasons. (1) **Strict-BFF alignment.** `next-frontend-config-base/TD-03` named Route Handlers as the BFF surface; Option A keeps every mutation visible under `app/api/**`. (2) **Test scaffold already exists** — `next-frontend/CLAUDE.md` § Testing and `next-frontend-msw-foundation` were authored for Route-Handlers-as-functions; Option A reuses them with zero invention. (3) **Single mutation surface** — Phase 02 sets the precedent for Phases 03–07; uniformity beats per-mutation idiom-picking when the cost of inconsistency compounds (Option C). Option B has real ergonomic appeal for the simplest forms but fragments the BFF surface and forces test-pattern reinvention; if the team later wants progressive enhancement for specific forms, the migration A→B is per-form and doesn't require touching unrelated routes — A is the safer default and the cheaper baseline.
**Libraries:** —

### phase-02-auth-frontend/TD-06

**Recommendation:** Two reinforcing reasons. (1) **No first-render flicker, no round-trip** — the session is delivered in the same response as the page HTML; the Client Provider hydrates with the correct initial state; users never see "Login" briefly turn into their avatar. (2) **No new BFF endpoint** — the cookie is the source of truth, RSC reads it, the Provider broadcasts it; the BFF surface stays minimal. The `router.refresh()` requirement after mid-session mutations is a small price (one line in the relevant mutation handler) for the structural benefits. Option B is rejected for the double-read-and-flicker; Option C is dominated by Option B and rejected.
**Libraries:** —

### phase-02-auth-frontend/TD-07

**Recommendation:** Three reasons. (1) **First-paint-correct** — the user sees the right outcome on the first paint, no skeleton, no flicker. (2) **Single integration pattern across both flows** — confirmation is RSC-only; reset is RSC + Client form (TD-04, TD-05 patterns reused) — both share the "RSC owns the token, Client Component owns the input" split. (3) **Email-prefetch behavior** is solved at the backend's idempotent-confirmation level (a small note for `/plan-build` to confirm; not a separate TD). Option B's Route-Handler-as-link-target adds redirects for no clean gain. Option C is dominated.
**Libraries:** —

### openapi-docs-nestjs/TD-01

**Recommendation:** é a única opção que preserva as decisões anteriores (`class-validator` em TD-06 de phase-02-auth) sem re-platform; o CLI plugin com `classValidatorShim: true` aproveita os decoradores `class-validator` existentes para inferir schemas, mantendo o boilerplate baixo. Nestia tem mérito técnico real mas o custo de migração do stack de validação inviabiliza-a sem uma decisão upstream de supersede de TD-06. Manual authoring é descartado.
**Libraries:** @nestjs/swagger

**Revisions:**
- 2026-05-12 — Esclarece que o CLI plugin (`classValidatorShim: true`) cobre apenas inferência de schemas de DTOs a partir de `class-validator`; documentação de operações, respostas tipadas por status code, contratos de erro (alinhados ao envelope de phase-02-auth/TD-07) e exemplos exigem decoradores explícitos (`@ApiOperation`, `@ApiResponse`, `@ApiBody`, `@ApiParam`, `@ApiQuery`, `@ApiExtraModels`). _Rationale:_ openapi.json gerado pelo bootstrap atual está genérico — sem detalhes de parâmetros, schemas de retorno por status, nem contratos de erro — porque a base instalada se apoiou só na introspecção automática. Esta revisão fixa que enriquecimento via decoradores explícitos faz parte da Option A escolhida, não é trabalho fora do escopo do TD.

### openapi-docs-nestjs/TD-02

**Recommendation:** o custo marginal sobre Option A é apenas um npm script (~15 linhas) e o benefício é uma fundação correta para futura integração FE (codegen offline) sem perder a UI interativa que dev/QA usam. Option B sozinho pune a experiência de desenvolvimento em dev/local; Option A sozinho compromete o pipeline de codegen futuro. Combinar é dominante.
**Libraries:** —

### openapi-docs-nestjs/TD-03

**Recommendation:** alinha com a postura defensiva já estabelecida em phase 02 e não compromete consumidores legítimos (o `openapi.json` commitado em TD-02 cumpre o papel de "spec consultável fora da UI"). Re-abrir como Option A ou C é trivial no futuro se um caso de uso de API pública aparecer.
**Libraries:** —

### next-frontend-config-base/TD-01

**Recommendation:** Three converging reasons: (1) **Type-inference matches the FE's strict-TS culture** — `lib/env.ts` exports a typed `env` object with no `as` casts, satisfying the project's "Type Safety" working principle. (2) **Ecosystem gravity in Next.js / React 19** — Zod is the de-facto schema language for App Router (Server Actions inputs, form resolvers, future contract validation), so introducing it once at the env layer compounds value for forms in Phase 02+. (3) **Direct enablement of TD-02 Option A (`@t3-oss/env-nextjs`)** — t3-env's first-citizen validator. Backend parity with Joi is not load-bearing: env schemas are not shared FE↔BE (different runtimes, different key sets); two validators across two subprojects is a bounded cost.
**Libraries:** zod

### next-frontend-config-base/TD-02

**Recommendation:** The only option that combines (i) **type-level NEXT_PUBLIC_ prefix enforcement**, (ii) **runtime Proxy-based leak detection**, and (iii) **single-file, single-import-path consumer ergonomics**. Option B reaches roughly the same _structural_ outcome at higher implementation and maintenance cost, with a weaker guarantee (no prefix enforcement, no proxy). Option C is unsafe at any non-trivial team size. The marginal cost over B is one ~3KB dep — well-spent for the strongest boundary among the three.
**Libraries:** @t3-oss/env-nextjs

### next-frontend-config-base/TD-03

**Recommendation:** Aligned with the BFF testing strategy and architectural commitment already documented in `next-frontend/CLAUDE.md` (Route Handlers as the only NestJS caller; BFF tests stub `fetch` via MSW). Eliminates CORS, eliminates public exposure of the backend URL, and produces the smallest correct foundation. Option B's `NEXT_PUBLIC_API_URL` is a future-proofing concession with no current consumer — and adding a public key later is a non-breaking change, while removing one is breaking. Option C ties a foundational decision to infra work explicitly deferred elsewhere. The Docker networking gap (how server-in-container resolves the backend) is a separate orthogonal decision, surfaced below.
**Libraries:** —

### next-frontend-msw-foundation/TD-01

**Recommendation:** Three reasons. (1) **MSW's own best-practice recommends it** — the project should not invent its own scheme when the official one is documented and matches the codebase's domain orientation. (2) **Domain ownership tracks the codebase**, not the project plan — `components/`, `app/api/`, and any future feature folders will be organized by domain (auth, videos, channels), so handler files mirror that vocabulary and remain stable as phases come and go. (3) **Append-only growth with minimal merge conflicts** — each phase touches a new file plus one line in the barrel, which is the smallest practical concurrent-PR footprint. Option A is acceptable through Phase 02 alone (~5–7 endpoints) but accumulates costs that B avoids from day one; bootstrapping directly into B costs one extra file and one barrel and pays off by Phase 03. Option C's phase coupling is rejected outright — domain-by-phase is a category error.
**Libraries:** —

### next-frontend-msw-foundation/TD-02

**Recommendation:** The browser worker is a future capability with no documented current consumer; wiring it now (Option B) is speculative investment, and wiring it incoherently (Option C) actively misleads developers into thinking interception works when it doesn't under strict BFF. Option A keeps the foundation minimal, aligns 1:1 with everything CLAUDE.md and the existing rules currently document, and is non-breaking to extend.
**Libraries:** —

### next-frontend-msw-foundation/TD-03

**Recommendation:** Reasons: (1) **Option B's determinism + readability is the right baseline** — every fixture in Phase 02 (5–7 endpoints, single-record-mostly) is naturally hand-written, and the diff-revealing override pattern is the highest-value benefit. (2) **Bulk-collection cases will arrive (Phase 07 home page grid, Phase 06 comment threads) and inline hand-written lists of 20+ items are genuinely tedious** — keeping faker available as a scoped tool is pragmatic. (3) **Per-fixture local seeding eliminates the global-cursor pitfall** that makes Option C structurally fragile — using `faker.seed(N)` immediately before a collection-builder run scopes the determinism to that fixture and isolates it from upstream changes to other factories.
**Libraries:** —

### next-frontend-msw-foundation/TD-04

**Recommendation:** The user's "import only what it needs" requirement is satisfied at the *authoring* layer by TD-01 (per-domain files; each phase adds one file). At the *runtime* layer, loading all handlers is the canonical MSW v2 model and imposes no cost on tests that don't fetch the extra URLs. `onUnhandledRequest: "error"` enforces that a phase's test cannot accidentally invoke a route outside its scope (the fetch fails loudly with "no handler matched"), which is the strongest version of "stays inside its phase" available. Option B's per-suite composition pays real boilerplate cost for an explicitness gain that TD-01 already provides at a different layer. Option C invents a Vitest-projects-shaped problem for a phase-shaped concern.
**Libraries:** —

### next-frontend-openapi-typing/TD-01

**Recommendation:** Three reinforcing reasons. (1) **Strict BFF makes the SDK surface valueless on the client.** Only Route Handlers ever call the upstream Nest; they already use `fetch` (Next 16's caching extensions sit on top of native `fetch`); a generated SDK adds a third client style to learn for zero functional gain. (2) **Types-first matches the rest of the FE foundation.** Env validation is Zod-derived types; component variants are `cva` types; both are TS-first with zero generated runtime. `paths` is the natural extension — one `.d.ts` file imported wherever the contract is touched. (3) **MSW typing is solved by the same `paths` symbol.** Hand-written handlers in `mocks/handlers.ts` type their resolver returns off `paths["/videos"]["get"]["responses"][200]`, giving the contract guarantee without orval/kubb's verbose generated handlers (which would be overridden per-test anyway). The marginal cost of adding `openapi-fetch` (~6KB, server-side only) is small enough that we recommend the **types + thin-client** pair, not types alone — `openapi-fetch` removes the `fetch(API_URL + path, { method, headers, body })` boilerplate in each Route Handler while staying within the BFF model. Options B/C/D may be revisited if (a) client-side data-fetching enters the stack with TanStack Query and per-endpoint hooks are wanted, or (b) the API grows beyond ~20 operations and per-call boilerplate becomes painful.
**Libraries:** openapi-typescript, openapi-fetch

### next-frontend-openapi-typing/TD-02

**Recommendation:** Three reasons. (1) **Preserves the compose-stack independence** that `next-frontend-config-base/TD-03` Context calls out as the current architecture — neither subproject's compose file references the other. (2) **Drift is eliminated structurally when paired with TD-03's CI freshness check** — the check runs the sync script and asserts no diff on either `openapi.json` or `types.gen.ts`, so a backend PR that forgets to re-sync fails CI with a clear message. (3) **The committed local file is a real artifact in PR review** — reviewers see the contract change in `next-frontend/openapi.json`'s diff at the same time as the backend change, doubling the visibility (an `openapi.json`-only diff in a feature PR is a red flag for accidental drift). Option A is acceptable as a pre-CI fallback; Option C is rejected because the cross-stack file dependency in `docker-compose.yaml` introduces coupling that the current architecture explicitly avoids, and the "no drift" gain over B is small once TD-03 lands.
**Libraries:** —

### next-frontend-openapi-typing/TD-03

**Recommendation:** It is the only option that makes contract drift _both_ visible (in PR diffs) _and_ impossible to merge accidentally (CI fail). The complexity premium over Option A is one CI step. Option B's "no committed artifacts" purity is poorly paid for in a monorepo where the cross-subproject build coupling becomes a real ergonomic cost, and it wastes the PR visibility that TD-02 Option B's committed `openapi.json` is specifically designed to deliver. Option A is acceptable as a temporary state until the CI pipeline lands; downgrading from C to A is reversible (just remove the CI step) but upgrading to C later requires explaining `types.gen.ts` history in a separate commit. Start at C. Apply the same script-and-check pattern to any future generated artifact (e.g., if `openapi-fetch` is wrapped, the wrapper file is hand-written; the only generated artifact remains `types.gen.ts`).
**Libraries:** —

### next-frontend-openapi-typing/TD-04

**Recommendation:** It is the only option that (i) handles pass-through and reshape with the same mechanism, (ii) gives a single grep target for "what shape does the BFF expose", and (iii) decouples Component imports from App Router file paths (Components import `from "@/lib/api/contracts"`, not `from "@/app/api/videos/route"`). Option B is theoretically minimal but fragile against Next's actual RSC/Client/Route-Handler typing; Option C scatters the contract surface and creates drift opportunities. The "long file" concern is bounded — for the scope of StreamTube, the BFF will likely have <30 contract aliases at peak; sectioning by feature header comments is sufficient. Make `lib/api/contracts.ts` the only file that imports `paths` from `types.gen.ts` (lintable later); every other consumer imports from `contracts.ts`.
**Libraries:** —

### next-frontend-openapi-typing/TD-05

**Recommendation:** Reasons: (1) **Determinism over auto-generation** — BFF integration tests assert on specific values; randomized fixtures are anti-helpful. (2) **Coherence with TD-01 recommendation** — `openapi-typescript`'s `paths` type is the single contract anchor; reusing it in MSW handlers means "spec ↔ handler ↔ assertion" is one type chain. (3) **Scale fit** — Phase 02 introduces few endpoints; the manual cost is negligible at this stage. If the API grows to dozens of endpoints and authoring overhead becomes real, this TD can be superseded with a Kubb-or-hey-api MSW plugin without touching TD-01's `paths` import sites (the generator just produces additional handler files; the existing manual handlers stay valid). Option B locks the project into a heavier TD-01 choice for marginal mock-authoring savings; Option C is Option A with an unnecessary detour.
**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions: ... _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function ... _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'` at the top, then imports `databaseConfig` and calls it as a plain function. _(from phase 01)_
- Database connection parameters (host, port, etc.) are sourced from a single `databaseConfig` factory — never duplicated between `AppModule` and ... _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `useFactory` returning options... _(from phase 01)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de frontend | deferred | phase-01-configuracao-base | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| "Confirmação de conta via e-mail com link de ativação" | deferred | phase-02-auth-frontend | deferred_to_next_phase — UI landing screen de-scoped 2026-05-14; FE confirmation flow (TD-07) picked up by a future phase. BE side unchanged in `phase-02-auth`. |
| "Logout" | deferred | phase-02-auth-frontend | deferred_to_next_phase — logout button lives inside authenticated chrome (typically Phase 04). Phase 02 still implements POST `/api/auth/logout` (BFF route handler + `session.destroy()`) so the contract is ready when the chrome lands. |
| "Recuperação de senha (destination screen / set-new-password)" | deferred | phase-02-auth-frontend | deferred_to_next_phase — `/forgot-password` ships this phase sending the e-mail; the reset-password destination screen is absent from Figma → link destination remains a 404 until a later phase delivers the screen via `/screen-inventory` extension run. Documented as a known gap. |
| "Telas de cadastro, login, confirmação de conta e recuperação de senha" | deferred | phase-02-auth-frontend | a tela de confirmação da conta não será implementada nesta fase corrente, será adiada — the umbrella bullet's full coverage requires the confirmação and reset-password destination screens; both are deferred per Non-UI rows above. The 3 ship-this-phase telas (signup, login, forgot-password) are inventoried and covered by their own verbs; the umbrella bullet itself is deferred to the phase that lands the missing screens. |

## Non-UI / Deferred Capabilities

| Capability | Status | Rationale | TD refs |
|-----------|--------|-----------|---------|
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | non-ui | backend_service — Phase 03 is backend-only (AMB-1); the upload control plane and storage contract ship here, while the FE upload client (Uppy/custom uploader respecting server-mediated Create/Complete) and BFF routes are deferred to Phases 04/05. | phase-03-videos/TD-04, phase-03-videos/TD-06, phase-03-videos/TD-07, phase-03-videos/TD-16 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | non-ui | backend_service — Phase 03 is backend-only (AMB-1); status is exposed by the API, while FE polling via BFF (TD-14) is deferred to Phases 04/05. | phase-03-videos/TD-03, phase-03-videos/TD-06, phase-03-videos/TD-08, phase-03-videos/TD-09, phase-03-videos/TD-14, phase-03-videos/TD-15 |
| URL única por vídeo, sem conflito com outros vídeos | non-ui | backend_service — Phase 03 is backend-only (AMB-1); `public_id` is generated and persisted here, while the FE watch route that validates it is deferred to Phase 05. | phase-03-videos/TD-12 |
| Reprodução via streaming (sem necessidade de download completo) | non-ui | backend_service — Phase 03 is backend-only (AMB-1); presigned playback URLs plus Range/206 are verified by backend e2e, while the FE `<video>` player is deferred to Phases 04/05. | phase-03-videos/TD-10, phase-03-videos/TD-11 |
| Download do vídeo pelo usuário | non-ui | backend_service — Phase 03 is backend-only (AMB-1); the presigned download URL (owner-only) ships here, while the FE download action is deferred to Phases 04/05. | phase-03-videos/TD-11 |

_AMB-1 resolution (2026-10-10):_ Phase 03 affects `nestjs-project` only, and `next-frontend` is deferred to Phases 04/05. The single exception is the OpenAPI contract re-sync: after the new endpoints land, run `scripts/sync-openapi.sh` and then `npm run openapi:types` in `next-frontend`, so the committed `next-frontend/openapi.json` and `lib/api/types.gen.ts` stay current. This follows `next-frontend-openapi-typing/TD-02` and `TD-03`.

## Testing Requirements

### nestjs-project

| Artifact type | Required layers |
|---------------|-----------------|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, `select: false` |
| Service with branching + DB | Unit: branch logic (mock repo) + Integration: DB contract |
| Service with DB only (no branching) | Integration: DB contract |
| Service with configured lib (JWT, cache) | Unit: real lib with test config |
| Service with side-effect dep (email, storage, queue) | Integration: real Mailpit / real MinIO (S3 API) / real Redis (BullMQ) |
| Queue processor (`@Processor` + `WorkerHost`) | Unit: error classification (mock collaborators) + Integration: real Redis worker (retries, `UnrecoverableError`, failed hook) |
| Job scheduler (`upsertJobScheduler`) | Integration: registration on real Redis + scheduled handler called directly |
| Module with configured imports | Unit: compilation test |
| Controller | E2E only — do NOT write unit tests |
| DTO | E2E: one validation wiring test per endpoint |
| Guard (delegates to service for business logic) | E2E + Unit if complex internal logic |
| Guard (simple, delegates to Passport) | E2E only |
| Strategy (Passport) | E2E via guard |
| Pipe (custom transformation/validation) | Unit |
| Interceptor (response transform, logging) | Unit and/or E2E |
| Exception Filter | Unit + E2E |
| Middleware | E2E |

_Source: `testing-guide-nestjs-project` § 3 Feature Implementation Checklist. Infrastructure recipes are in the guide's `references/external-systems.md`: MinIO via the S3 API (internal vs public endpoint, test bucket cleanup) and BullMQ on Redis (per-file `prefix`, `obliterate`, teardown). Processor and job-scheduler recipes are in `artifacts/processors.md`._
