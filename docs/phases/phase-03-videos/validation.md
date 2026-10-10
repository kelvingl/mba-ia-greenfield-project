---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-10-10T13:58:38-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-10T13:57:52-03:00"
issues:
  - id: IC-1
    status: resolved
    summary: "TD-04 Recommendation names `complete` as processing trigger; TD-06 B/TD-07 disagree"
    resolved_by: phase-03-videos/TD-04
  - id: IC-2
    status: resolved
    summary: "TD-01 requires testing-guide storage revision; Testing Requirements still say local adapter"
    resolved_by: clarification
  - id: IC-3
    status: resolved
    summary: "TD-01/02/08 name libraries in prose but Libraries field is `—`"
    resolved_by: phase-03-videos/TD-01, phase-03-videos/TD-02, phase-03-videos/TD-08
  - id: AMB-1
    status: resolved
    summary: "Phase 03 subproject boundary unstated while 7 Cross-layer TDs reference FE"
    resolved_by: clarification
  - id: MD-1
    status: resolved
    summary: "No TD picks mechanism/host process for TD-07's 24h stale-upload sweep"
    resolved_by: phase-03-videos/TD-16
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

### Ambiguities

_None._

### Missing Decisions

_None._

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

_None._

### UI Coverage Gaps

_None._ _(No `## UI Inventory` in context.md, so UI is not in scope and Check 7 does not apply.)_

## Resolved Issues

- **MD-1** _(resolved_by phase-03-videos/TD-16)_ — No TD picked the mechanism or host process for TD-07's 24h stale-upload sweep. TD-16 (decided A) assigns it to a BullMQ Job Scheduler on a dedicated `maintenance` queue, processed by the video worker.
- **IC-1** _(resolved_by phase-03-videos/TD-04)_ — TD-04's Recommendation named `complete` as the processing trigger and size-check point, which TD-06 B and the TD-07 Revision contradict. A 2026-10-10 Revision was appended to TD-04: `complete` only finalizes the multipart upload (202), and the trigger and size check live in the TD-06 B consumer. Decision A is unchanged.
- **IC-2** _(resolved_by clarification)_ — TD-01 (MinIO) makes the testing guide's "local adapter" storage strategy stale, and the guide lacks a BullMQ/Redis recipe. User chose to **update `testing-guide-nestjs-project` as a separate docs task before `/plan-build`** (storage → MinIO via S3 API; queue → real Redis/BullMQ). It is out of this pipeline run per CLAUDE.md scope limits. **Done 2026-10-10:**
  - The guide now covers MinIO via the S3 API and BullMQ on real Redis (`references/external-systems.md`), plus a new `artifacts/processors.md`.
  - `context.md` `## Testing Requirements` was regenerated from it and now lists the storage/queue, queue-processor and job-scheduler rows.
- **IC-3** _(resolved_by phase-03-videos/TD-01, TD-02, TD-08)_ — The `**Libraries:**` fields are now filled, each with a Revision entry and with Decisions unchanged:
  - TD-01: `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`.
  - TD-02: `bullmq`, `@nestjs/bullmq`.
  - TD-08: `fluent-ffmpeg`, `@types/fluent-ffmpeg`.

  `library-refs.md` was created for all six.
- **AMB-1** _(resolved_by clarification)_ — Phase 03 is **backend-only**: `nestjs-project` is affected, and `next-frontend` is deferred to Phases 04/05. The FE side of the user-facing capabilities is recorded as `non-ui` (backend_service) in context.md `## Non-UI / Deferred Capabilities`. The only `next-frontend` change is the OpenAPI contract re-sync (`scripts/sync-openapi.sh` + `npm run openapi:types`), which follows `next-frontend-openapi-typing/TD-02` and `TD-03`.
