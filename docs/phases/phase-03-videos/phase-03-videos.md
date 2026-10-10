---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-10-10T13:58:38-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-10-10T13:49:26-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-10T13:57:52-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-10-07T22:40:21-03:00"
  docs/decisions/technical-decisions-next-frontend-config-base.md: "2026-10-07T22:40:21-03:00"
  docs/decisions/technical-decisions-next-frontend-msw-foundation.md: "2026-10-07T22:40:21-03:00"
  docs/decisions/technical-decisions-next-frontend-openapi-typing.md: "2026-10-07T22:40:21-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver the backend for "Upload e Processamento de Vídeos" in `nestjs-project`. That covers four capabilities:
- **Storage and queue:** a file storage service for videos and thumbnails, and a background processing service (queues).
- **Upload:** uploads of up to 10GB with no impact on API performance, with the video pre-registered as a draft when the upload starts.
- **Processing:** automatic extraction of duration and metadata, plus a thumbnail generated from a frame.
- **Delivery:** a unique URL per video, streaming playback without a full download, and download by the user.

This meets the deliverables "upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas".

---

## Step Implementations

### SI-03.1 — Infra: Dependências, Namespaces de Configuração e Validação de Env

**Description:** Instala as bibliotecas fixadas da fase e cria as configurações de storage e fila. Os demais SIs dependem desses valores de configuração tipados e validados.

**Technical actions:**

1. Instalar no container (`docker compose exec nestjs-api npm install ...`) as versões fixadas em `library-refs.md`:
   - `@aws-sdk/client-s3@^3.1149.0` e `@aws-sdk/s3-request-presigner@^3.1149.0` (per `phase-03-videos/TD-01`);
   - `bullmq@^6.3.12` e `@nestjs/bullmq@^12.0.0` (per `phase-03-videos/TD-02`);
   - `fluent-ffmpeg@2.1.3` com pin exato, e `@types/fluent-ffmpeg@^2.1.28` como devDependency (per `phase-03-videos/TD-08` Revision).
2. Criar `src/config/storage.config.ts` — `registerAs('storage', ...)` com os campos `endpoint`, `publicEndpoint`, `region`, `accessKeyId`, `secretAccessKey`, `bucket`, `partUrlTtlSeconds` (3600), `deliveryUrlTtlSeconds` e `webhookToken`. Endpoint interno e endpoint público ficam separados (per `phase-03-videos/TD-11`; convenção `registerAs` herdada de `phase-01-configuracao-base/TD-03`).
3. Criar `src/config/queue.config.ts` — `registerAs('queue', ...)` com os campos `redisHost`, `redisPort` e `processingBackoffDelayMs`. O delay é configurável para os testes encolherem o backoff (per `phase-03-videos/TD-02`, `phase-03-videos/TD-15`).
4. Estender o schema Joi em `src/config/env.validation.ts` com as novas chaves (per `phase-01-configuracao-base/TD-02`):
   - obrigatórias: `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET`, `STORAGE_WEBHOOK_TOKEN`, `REDIS_HOST`, `REDIS_PORT`;
   - opcionais com default: `S3_DELIVERY_URL_TTL_SECONDS`, `VIDEO_PROCESSING_BACKOFF_MS`.
5. Atualizar `.env.example` (e o `.env` local):
   - hosts internos pelo nome de serviço do Compose: `S3_ENDPOINT=http://minio:9000`, `REDIS_HOST=redis`;
   - `S3_PUBLIC_ENDPOINT=http://localhost:9000` é a única URL voltada ao host, porque quem a consome é o browser (per `phase-03-videos/TD-11`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `env.validation.ts` (novas chaves) | Unit: rejeita env sem chaves obrigatórias de storage/fila; aplica defaults das opcionais | `src/config/env.validation.spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- A aplicação não sobe (erro de validação Joi nomeando a chave) quando `S3_BUCKET`, `S3_PUBLIC_ENDPOINT`, `STORAGE_WEBHOOK_TOKEN` ou `REDIS_HOST` está ausente.
- Com `.env.example` copiado para `.env`, a aplicação sobe e `ConfigType<typeof storageConfig>` expõe `partUrlTtlSeconds = 3600`.
- `package.json` fixa `fluent-ffmpeg` exatamente em `2.1.3`.
- `.env.example` não tem `localhost` em nenhum host interno; só `S3_PUBLIC_ENDPOINT` aponta para o host.

---

### SI-03.2 — Infra: Docker Compose com MinIO, Redis e FFmpeg na Imagem

**Description:** Sobe o object storage e o broker da fila no `nestjs-project/compose.yaml`, com bucket, CORS, lifecycle e prefixo público já configurados. Também coloca o FFmpeg na imagem, base que o storage, a fila e o worker usam.

**Technical actions:**

1. Adicionar o serviço `minio` ao `compose.yaml` com imagem de tag fixada (dev/test only):
   - portas `9000` (API S3) e `9001` (console), volume nomeado e healthcheck;
   - credenciais vindas do `.env` (per `phase-03-videos/TD-01`).
2. Adicionar o serviço one-shot `minio-init` (imagem `minio/mc` fixada, `depends_on: minio: service_healthy`), que configura:
   - o bucket `S3_BUCKET`;
   - CORS para a origem do FE (`http://localhost:3001`) com métodos `PUT`/`GET`/`HEAD` e expondo `ETag`;
   - lifecycle `AbortIncompleteMultipartUpload` após 1 dia;
   - leitura anônima só no prefixo `thumbnails/`.

   (per `phase-03-videos/TD-01` Revision, `phase-03-videos/TD-04`, `phase-03-videos/TD-07` Revision, `phase-03-videos/TD-11`)
3. Adicionar o serviço `redis` (imagem de tag fixada, porta `6379`, healthcheck `redis-cli ping`) (per `phase-03-videos/TD-02`).
4. Instalar `ffmpeg` (inclui `ffprobe`) pelo gerenciador de pacotes do SO no `Dockerfile.dev`. A versão fica controlada pela imagem, não pelo npm (per `phase-03-videos/TD-08` Revision).
5. Fazer `nestjs-api` depender de `minio` (healthy), `minio-init` (completed) e `redis` (healthy).

**Tests:** _(empty — Infra; smoke-gated by the acceptance criteria below)_

**Dependencies:** SI-03.1 (chaves de env usadas pelo Compose)

**Acceptance criteria:**

- `docker compose up -d` deixa `minio` e `redis` com status `healthy` e `minio-init` com exit code `0`.
- Uma leitura anônima de um objeto em `thumbnails/` responde `200`; a mesma leitura anônima em `originals/` responde `403`.
- A regra de lifecycle `AbortIncompleteMultipartUpload` (1 dia) aparece nas regras do bucket (`mc ilm rule ls`).
- `docker compose exec nestjs-api ffprobe -version` sai com código `0`.
- `docker compose exec nestjs-api sh -c 'redis-cli -h redis ping || node -e "require(\"net\").connect(6379,\"redis\").on(\"connect\",()=>process.exit(0))"'` conecta no Redis pelo nome de serviço.

---

### SI-03.3 — Módulo de Storage sobre a API S3

**Description:** Encapsula todo acesso ao object storage num `StorageService` que só conhece a API S3 (MinIO em dev, S3 em produção). É o único ponto do código que fala com o storage.

**Technical actions:**

1. Criar `src/storage/storage.module.ts`, que provê dois `S3Client` a partir de `storageConfig` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-11`; ver `library-refs.md` → `@aws-sdk/client-s3`):
   - **interno** (`S3_ENDPOINT`): chamadas servidor-a-servidor;
   - **assinador público** (`S3_PUBLIC_ENDPOINT`): URLs consumidas pelo browser;
   - ambos com `forcePathStyle: true` e `requestChecksumCalculation`/`responseChecksumValidation: 'WHEN_REQUIRED'`.

   O módulo exporta `StorageService`.
2. Criar `src/storage/storage-keys.ts` com builders das chaves do bucket único (per `phase-03-videos/TD-01` Revision):
   - `originalKey(videoId, ext)` → `originals/{videoId}/source{ext}`;
   - `playbackKey(videoId)` → `playback/{videoId}.mp4`;
   - `thumbnailKey(videoId)` → `thumbnails/{videoId}.jpg`;
   - `parseVideoIdFromOriginalKey(key)`.
3. Criar `src/storage/storage.service.ts` com estas operações (per `phase-03-videos/TD-04`, `phase-03-videos/TD-07`, `phase-03-videos/TD-09`, `phase-03-videos/TD-11`; ver `library-refs.md` → `@aws-sdk/s3-request-presigner`):
   - multipart: `createMultipartUpload`, `presignUploadParts` (assinador público, TTL `partUrlTtlSeconds`), `listParts`, `completeMultipartUpload` (lança `InvalidUploadPartsError` em `InvalidPart`/`InvalidPartOrder`/`EntityTooSmall`);
   - objetos: `headObject`, `deleteObject`, `putObjectFromFile`;
   - URLs: `presignGet` (assinador público; `responseContentDisposition` opcional; TTL `deliveryUrlTtlSeconds`), `presignInternalGet` (cliente interno, entrada do ffprobe no worker), `publicObjectUrl(key)` (thumbnails).
4. Criar `src/test/s3.ts`, helper de teste que espelha `src/test/mailpit.ts`: `internalS3Client`, `TEST_BUCKET`, `emptyTestBucket()` (lista paginada + delete por chave + abort de multiparts pendentes).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageModule` | Unit: compilation test (DI dos dois clientes) | `src/storage/storage.module.spec.ts` |
| `storage-keys.ts` | Unit: formato das chaves + `parseVideoIdFromOriginalKey` (válida, prefixo errado, malformada) | `src/storage/storage-keys.spec.ts` |
| `StorageService` | Integration (MinIO real): multipart de 2 partes ponta a ponta via URLs presigned internas; `completeMultipartUpload` com ETag errado lança `InvalidUploadPartsError`; `headObject` retorna o tamanho; GET presigned com `Range` responde `206`; URL pública aponta para o host de `S3_PUBLIC_ENDPOINT` | `src/storage/storage.service.integration-spec.ts` |

**Dependencies:** SI-03.1 (libs + `storageConfig`), SI-03.2 (MinIO no Compose)

**Acceptance criteria:**

- Um upload multipart de 2 partes (≥5 MiB na primeira) concluído pelo `StorageService` produz um objeto cujo `HeadObject.ContentLength` é a soma das partes.
- Um GET presigned com `Range: bytes=0-1023` sobre um objeto de 4096 bytes responde `206` com `content-length: 1024`.
- URLs presigned voltadas ao browser têm a origem de `S3_PUBLIC_ENDPOINT` e `X-Amz-Expires` igual ao TTL configurado.
- URLs de download carregam `response-content-disposition` com `attachment`.
- `completeMultipartUpload` com uma lista de partes inválida falha com um erro tipado, sem vazar o erro cru do SDK.

---

### SI-03.4 — Módulo de Fila e Entrypoint do Video Worker

**Description:** Liga o BullMQ ao Redis e cria o segundo entrypoint, o worker sem HTTP, rodando num container próprio a partir do mesmo código. Isso isola a CPU do FFmpeg da API.

**Technical actions:**

1. Criar `src/queue/queue.constants.ts`, com nomes e opções da fila (per `phase-03-videos/TD-02`, `phase-03-videos/TD-15`):
   - filas `VIDEO_PROCESSING_QUEUE = 'video-processing'` e `MAINTENANCE_QUEUE = 'maintenance'`;
   - jobs `PROCESS_VIDEO_JOB = 'process-video'` e `SWEEP_STALE_UPLOADS_JOB = 'sweep-stale-uploads'`;
   - factory `processingJobOptions(delayMs)` → `{ attempts: 3, backoff: { type: 'exponential', delay: delayMs } }`.
2. Criar `src/queue/queue.module.ts` (per `phase-03-videos/TD-02`; ver `library-refs.md` → `@nestjs/bullmq`):
   - `BullModule.forRootAsync` com `inject: [queueConfig.KEY]` e conexão `{ host: redisHost, port: redisPort }`;
   - `BullModule.registerQueue` para as duas filas.

   Importado pelo `AppModule` só como produtor: nenhum `@Processor` é registrado no processo da API.
3. Criar `src/worker.module.ts` e `src/worker.ts`:
   - `WorkerModule` importa `ConfigModule`, TypeORM (mesmo `databaseConfig`), `StorageModule` e `QueueModule`;
   - `worker.ts` faz `NestFactory.createApplicationContext(WorkerModule)` com `enableShutdownHooks()`, sem servidor HTTP.

   (per `phase-03-videos/TD-03`)
4. Adicionar os scripts `start:worker` (build) e `start:worker:dev` (watch) ao `package.json`. Adicionar o serviço `video-worker` ao `compose.yaml`: mesmo build da API, `command: npm run start:worker:dev`, `depends_on` `db`/`redis`/`minio` healthy (per `phase-03-videos/TD-03`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `QueueModule` | Unit: compilation test (conexão BullMQ + duas filas resolvem) | `src/queue/queue.module.spec.ts` |
| `WorkerModule` | Unit: compilation test (worker sobe sem HTTP) | `src/worker.module.spec.ts` |
| `processingJobOptions` | Unit: `attempts: 3`, backoff exponencial com o delay recebido | `src/queue/queue.constants.spec.ts` |

**Dependencies:** SI-03.1 (libs + `queueConfig`), SI-03.2 (Redis/MinIO no Compose), SI-03.3 (`StorageModule` importado pelo worker)

**Acceptance criteria:**

- `docker compose up -d` deixa `video-worker` em execução, e seu log mostra o contexto de aplicação inicializado, sem nenhum servidor HTTP escutando.
- O processo da API (`AppModule`) não registra nenhum worker do BullMQ.
- Um job adicionado em `video-processing` com `jobId` repetido não cria um segundo job.

---

### SI-03.5 — Entidade Video, Migration CreateVideos e Gerador de public_id

**Description:** Cria a tabela de vídeos ligada ao canal: identificação, dono, título, status nos dois eixos, chaves de storage, metadados e o identificador da URL única. Também cria o gerador do `public_id`. É a base de persistência de todos os SIs de vídeo.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` conforme `### Data Model → Video`:
   - colunas, tipos, nulabilidade e defaults verbatim, incluindo o enum `video_processing_status` com default `'uploading'` e `published_at` nullable (per `phase-03-videos/TD-05`);
   - `@ManyToOne(() => Channel)` via `channel_id`.
2. Criar `src/database/migrations/<timestamp>-CreateVideos.ts` (via `npm run migration:create`, seguindo `.claude/rules/typeorm-migrations.md`). A migration cria o tipo enum `video_processing_status`, a tabela `videos`, a FK para `channels.id` e os índices `(public_id)` unique, `(channel_id)` e `(processing_status, created_at)`. Aplicar com `npm run migration:run`.
3. Criar `src/videos/public-id.ts` — `generatePublicId()`: 8 bytes de `node:crypto` `randomBytes`, codificados em base64url, dando exatamente 11 chars `[A-Za-z0-9_-]` (per `phase-03-videos/TD-12`).
4. Criar `src/videos/videos.module.ts` com `TypeOrmModule.forFeature([Video])` e registrá-lo no `AppModule` (forma de referência: `auth/`). Registrar `Video` também nas entidades carregadas pelo `WorkerModule`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` entity | Integration: `public_id` duplicado viola unique; default `processing_status = 'uploading'`; `published_at` nulo por padrão; `channel_id` inexistente viola FK; enum rejeita valor fora da lista | `src/videos/entities/video.entity.integration-spec.ts` |
| Migration `CreateVideos` | Integration: `migration:run` cria `videos` + enum + índices; `migration:revert` remove | `src/database/migrations.integration-spec.ts` (estender) |
| `generatePublicId` | Unit: 11 chars, alfabeto base64url, sem padding, valores distintos em 10 000 chamadas | `src/videos/public-id.spec.ts` |
| `VideosModule` | Unit: compilation test | `src/videos/videos.module.spec.ts` |

**Dependencies:** SI-03.4 (o `WorkerModule` precisa existir para registrar `Video` nas entidades do worker)

**Acceptance criteria:**

- `npm run migration:run` cria a tabela `videos` com a FK `channel_id → channels.id` e o índice único em `public_id`; `npm run migration:revert` desfaz.
- Inserir um vídeo sem `processing_status` persiste `'uploading'` com `published_at` nulo, ou seja, o estado "rascunho".
- Inserir dois vídeos com o mesmo `public_id` falha com violação de unicidade.
- `processing_status` aceita apenas `uploading`, `processing`, `ready` e `failed`.

---

### SI-03.6 — Endpoint POST /videos: Pré-cadastro do Rascunho e Início do Multipart

**Route:** POST /videos
**Test Specs:** _pending /plan-test-specs_
**Authorization:** Authenticated (vídeo criado no canal do chamador)

**Description:** Ao iniciar o upload, cria o vídeo como rascunho (`uploading`, `published_at` nulo) no canal do usuário e abre o multipart no storage. O cliente recebe o tamanho de parte ditado pelo servidor; nenhum byte do arquivo passa pela API.

**Technical actions:**

1. Criar `src/videos/videos.exceptions.ts` com as exceções de domínio de `### Error Catalog`, no padrão `DomainException(errorCode, httpStatus, message)` (per `phase-02-auth/TD-07`): `VideoNotFoundException` (`VIDEO_NOT_FOUND`), `InvalidUploadStateException` (`INVALID_UPLOAD_STATE`), `InvalidPartNumberException` (`INVALID_PART_NUMBER`), `InvalidUploadPartsException` (`INVALID_UPLOAD_PARTS`), `VideoNotReadyException` (`VIDEO_NOT_READY`) e `InvalidWebhookTokenException` (`INVALID_WEBHOOK_TOKEN`).
2. Criar `src/videos/dto/create-video.dto.ts` com `filename`, `size`, `mime_type` e `title`, conforme `#### Validation Rules — upload control plane` (per `phase-02-auth/TD-06`, `phase-03-videos/TD-07` Revision).
3. Criar `VideosService.createDraft(userId, dto)` em `src/videos/videos.service.ts`:
   - resolve o canal do usuário;
   - deriva `title` (default: filename sem extensão, truncado em 100) e `part_count = ceil(size / 67108864)`;
   - gera `public_id`, com retry em violação de unique (per `phase-03-videos/TD-12`);
   - numa transação, insere a linha com `original_key`, chama `StorageService.createMultipartUpload` e grava `upload_id`; se o storage falhar, faz rollback.

   (per `phase-03-videos/TD-04`, `phase-03-videos/TD-05`, `phase-03-videos/TD-07`)
4. Criar `src/videos/videos.controller.ts` com `POST /videos` (`@SkipThrottle()` no controller, per `phase-02-auth/TD-08`), que retorna `201` com `public_id`, `title`, `processing_status` e `upload: { part_size, part_count }` conforme `### API Contracts → POST /videos`. Registrar controller e service no `VideosModule`, importando `StorageModule`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.createDraft` | Unit: título padrão/truncado; `part_count` para 1 byte, 64 MiB exatos e 10 GiB (= 160); retry de `public_id` em colisão (mock repo) | `src/videos/videos.service.spec.ts` |
| `VideosService.createDraft` | Integration (Postgres + MinIO reais): linha criada em `uploading` com `published_at` nulo, `upload_id` aponta para um multipart existente; falha do storage não deixa linha órfã | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.3 (`StorageService`), SI-03.5 (entidade `Video` + `VideosModule`)

**Acceptance criteria:**

- `POST /videos` com `{ filename: "aula.mp4", size: 1048576, mime_type: "video/mp4" }` e token válido retorna `201` com `processing_status: "uploading"`, `title: "aula"`, `upload.part_size: 67108864` e `upload.part_count: 1`.
- `POST /videos` com `size: 10737418241` retorna `400` com o envelope de erro de validação.
- `POST /videos` com `mime_type: "image/png"` retorna `400` com o envelope de erro de validação.
- `POST /videos` sem token retorna `401`.
- Após um `201`, a linha em `videos` pertence ao canal do chamador, tem `published_at` nulo e um `public_id` de 11 caracteres.
- Mais de 10 chamadas por minuto ao `POST /videos` não recebem `429`.

---

### SI-03.7 — Endpoints do Plano de Controle do Upload: URLs de Parte, Partes Enviadas e Conclusão

**Route:** POST /videos/:publicId/upload/part-urls; GET /videos/:publicId/upload/parts; POST /videos/:publicId/upload/complete
**Test Specs:** _pending /plan-test-specs_
**Authorization:** Owner (canal do vídeo = canal do chamador; não-dono recebe `404 VIDEO_NOT_FOUND`)

**Description:** Permite que o cliente envie até 10GB direto ao storage em partes presigned, retome pela listagem de partes e finalize o multipart. A API só assina e coordena; a conclusão não enfileira o processamento.

**Technical actions:**

1. Criar `VideosService.findOwnedOrFail(userId, publicId)`. Lança `VideoNotFoundException` quando o vídeo não existe ou pertence a outro canal, para não vazar a existência de rascunhos. Criar também o helper que exige `processing_status = 'uploading'` e `upload_id` ativo, ou lança `InvalidUploadStateException`.
2. Criar `VideosService.signUploadParts(userId, publicId, partNumbers)`: valida cada número em `1..part_count` (senão lança `InvalidPartNumberException`) e retorna as URLs de `StorageService.presignUploadParts` com `expires_in = 3600` (per `phase-03-videos/TD-04`, `phase-03-videos/TD-07` Revision).
3. Criar dois métodos de serviço (per `phase-03-videos/TD-04` Revision, `phase-03-videos/TD-06` Revision):
   - `VideosService.listUploadedParts`: retorna `ListParts`, para retomada;
   - `VideosService.completeUpload`: chama `StorageService.completeMultipartUpload` e mapeia `InvalidUploadPartsError` → `InvalidUploadPartsException`. **Não** enfileira processamento nem verifica tamanho.
4. Criar `src/videos/dto/sign-upload-parts.dto.ts` e `src/videos/dto/complete-upload.dto.ts` conforme `#### Validation Rules`. Adicionar ao `VideosController` as três rotas com as respostas de `### API Contracts`: `200` para part-urls, `200` para parts e `202` para complete.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService` (upload control plane) | Unit: part number fora de faixa → `INVALID_PART_NUMBER`; estado ≠ `uploading` → `INVALID_UPLOAD_STATE`; vídeo de outro canal → `VIDEO_NOT_FOUND`; erro tipado do storage → `INVALID_UPLOAD_PARTS` (mocks) | `src/videos/videos.service.spec.ts` (estender) |
| `VideosService` (upload control plane) | Integration (Postgres + MinIO reais): assinar 2 partes, PUT pelas URLs internas, `listUploadedParts` devolve os ETags, `completeUpload` cria o objeto em `originals/{id}/`, e o status continua `uploading` | `src/videos/videos.service.integration-spec.ts` (estender) |

**Dependencies:** SI-03.6 (rascunho + multipart iniciado)

**Acceptance criteria:**

- `POST /videos/:publicId/upload/part-urls` com `{ part_numbers: [1, 2] }` retorna `200` com duas URLs presigned na origem de `S3_PUBLIC_ENDPOINT` e `expires_in: 3600`.
- `POST /videos/:publicId/upload/part-urls` com um número maior que `part_count` retorna `400` com `INVALID_PART_NUMBER`.
- `GET /videos/:publicId/upload/parts` após o envio de duas partes retorna `200` com as duas partes e seus `etag`.
- `POST /videos/:publicId/upload/complete` com os ETags corretos retorna `202` com `processing_status: "uploading"`.
- `POST /videos/:publicId/upload/complete` com um ETag adulterado retorna `400` com `INVALID_UPLOAD_PARTS`.
- Qualquer rota de upload chamada por um usuário que não é dono do vídeo retorna `404` com `VIDEO_NOT_FOUND`.
- Qualquer rota de upload sobre um vídeo que já não está `uploading` retorna `409` com `INVALID_UPLOAD_STATE`.

---

### SI-03.8 — Webhook de Eventos do Storage, Verificação de Tamanho e Enfileiramento

**Route:** POST /internal/storage-events
**Test Specs:** _pending /plan-test-specs_
**Authorization:** Storage webhook token (only) — `@Public()` fora do guard JWT global

**Description:** Dispara o processamento a partir do fato registrado pelo storage (o objeto passou a existir), não de um relato do cliente. Verifica o tamanho real e move o vídeo de `uploading` para `processing`, enfileirando o job uma única vez.

**Technical actions:**

1. Criar `src/videos/storage-events/storage-webhook-token.guard.ts`. Compara `Authorization: Bearer <token>` com `storageConfig.webhookToken` em tempo constante (`crypto.timingSafeEqual`) e lança `InvalidWebhookTokenException` se não bater (per `phase-03-videos/TD-06` Revision).
2. Criar `src/videos/storage-events/storage-events.service.ts` → `handleObjectCreated(record)` (per `phase-03-videos/TD-06` Revision, `phase-03-videos/TD-07` Revision):
   1. resolve o `videoId` pela chave (`parseVideoIdFromOriginalKey`);
   2. confere o tamanho com `HeadObject`;
   3. se o tamanho for maior que 10 737 418 240 ou maior que `declared_size`: `deleteObject` + update condicional para `failed` / `file_too_large`;
   4. senão: update condicional `WHERE processing_status = 'uploading'` que grava `size`, limpa `upload_id` e muda para `processing`;
   5. se a linha mudou, `queue.add(PROCESS_VIDEO_JOB, { videoId }, { ...processingJobOptions(delay), jobId: videoId })`.
3. Criar `src/videos/storage-events/storage-events.controller.ts` com `POST /internal/storage-events`, decorado com `@Public()`, `@SkipThrottle()`, `@UseGuards(StorageWebhookTokenGuard)` e `@ApiExcludeEndpoint()`:
   - processa só os records `s3:ObjectCreated:CompleteMultipartUpload`;
   - responde `204` inclusive para eventos ignorados ou duplicados.

   Registrar no `VideosModule`, importando `QueueModule`.
4. Configurar a notificação no `minio-init` (`compose.yaml`):
   - target `notify_webhook` → `http://nestjs-api:3000/internal/storage-events`, com `auth_token` = `STORAGE_WEBHOOK_TOKEN` e `queue_dir` persistente, para eventos não se perderem com a API fora do ar;
   - `mc event add` para `s3:ObjectCreated:CompleteMultipartUpload`, só no prefixo `originals/`.

   (per `phase-03-videos/TD-06` Revision)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageWebhookTokenGuard` | Unit: token correto passa; ausente/errado → `INVALID_WEBHOOK_TOKEN` | `src/videos/storage-events/storage-webhook-token.guard.spec.ts` |
| `StorageEventsService` | Integration (Postgres + MinIO + Redis reais, `prefix` BullMQ por arquivo): evento válido → `processing` + 1 job `process-video` com `jobId = videoId`; evento duplicado → continua 1 job; objeto maior que `declared_size` → objeto removido e `failed`/`file_too_large`; vídeo já em `processing` → nada muda | `src/videos/storage-events/storage-events.service.integration-spec.ts` |

**Dependencies:** SI-03.4 (`QueueModule` + `processingJobOptions`), SI-03.7 (o `complete` gera o evento)

**Acceptance criteria:**

- `POST /internal/storage-events` sem token, ou com token errado, retorna `401` com `INVALID_WEBHOOK_TOKEN`.
- Concluir um upload válido faz o MinIO entregar o evento; o vídeo passa de `uploading` para `processing` com `size` gravado, e existe exatamente um job `process-video` cujo `jobId` é o id do vídeo.
- Entregar o mesmo evento duas vezes mantém um único job e não altera o vídeo na segunda entrega.
- Um objeto maior que o `declared_size` é removido do bucket, e o vídeo fica `failed` com `failure_reason: "file_too_large"`, sem job enfileirado.
- A rota não aparece no documento OpenAPI público.

---

### SI-03.9 — FfmpegService: Probe, Thumbnail e Normalização para Playback

**Description:** Concentra todo uso de FFmpeg/ffprobe num único serviço tipado. Ele extrai duração e metadados, gera o thumbnail e produz o MP4 faststart de streaming, e classifica falhas permanentes de mídia.

**Technical actions:**

1. Criar `src/videos/processing/ffmpeg.service.ts`, única classe que importa `fluent-ffmpeg`. Os resultados são tipados, e o processor nunca vê tipos do wrapper (per `phase-03-videos/TD-08` Revision; ver `library-refs.md` → `fluent-ffmpeg`, `@types/fluent-ffmpeg`).
2. `probe(input)` → `{ durationSeconds, width, height, videoCodec, audioCodec | null }` a partir de `format.duration` e `streams[]` (per `phase-03-videos/TD-08`, `phase-03-videos/TD-09`):
   - `input` pode ser caminho local ou URL presigned interna (leitura por Range);
   - sem stream `codec_type === 'video'`, ou container ilegível → lança `PermanentMediaError`.
3. `extractThumbnail(input, durationSeconds, outPath)` (per `phase-03-videos/TD-13`):
   - `seekInput` num offset do início do vídeo;
   - `videoFilters(['thumbnail', 'scale=1280:-2'])`, `frames(1)`, saída JPEG.

   É um comando de saída normal, não `screenshots()`, que não convive com filtros.
4. `normalizeForPlayback(inputPath, probe, outPath)` (per `phase-03-videos/TD-10`):
   - remux `-c copy -movflags +faststart` quando o vídeo já é H.264 e o áudio é AAC ou ausente;
   - senão, transcode para H.264/AAC com `-movflags +faststart`;
   - escreve sempre em arquivo, nunca em pipe.

   Expor a decisão como função pura `needsTranscode(probe)`.
5. Criar `src/test/media.ts`, que gera fixtures sob demanda com o ffmpeg do container (`lavfi testsrc`/`sine`): MP4 H.264/AAC de 2 s, WebM VP9/Opus de 2 s, arquivo só de áudio e arquivo de bytes aleatórios. Nenhuma fixture binária vai para o repo.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `needsTranscode` | Unit: H.264+AAC → remux; H.264 sem áudio → remux; VP9 → transcode; H.264+Opus → transcode | `src/videos/processing/ffmpeg.service.spec.ts` |
| `FfmpegService` | Integration (FFmpeg real no container + MinIO): probe de MP4 local e via URL presigned interna retorna duração ≈ 2 s e dimensões; áudio puro e bytes aleatórios → `PermanentMediaError`; thumbnail é JPEG com 1280 px de largura; MP4 H.264/AAC é remuxado com `moov` antes de `mdat`; WebM sai H.264/AAC faststart | `src/videos/processing/ffmpeg.service.integration-spec.ts` |

**Dependencies:** SI-03.1 (`fluent-ffmpeg` instalado), SI-03.2 (FFmpeg na imagem)

**Acceptance criteria:**

- Fazer o probe de um MP4 H.264/AAC de 2 s retorna duração entre 1,9 e 2,1 s, largura/altura iguais às do arquivo e codecs `h264`/`aac`.
- Fazer o probe de um arquivo sem stream de vídeo lança `PermanentMediaError`.
- O thumbnail gerado é um JPEG com 1280 px de largura e altura par, proporcional à original.
- A saída de playback de qualquer fixture de vídeo é MP4 H.264/AAC com o átomo `moov` antes do `mdat`, ou seja, tocável progressivamente via Range.

---

### SI-03.10 — VideoProcessor: Pipeline de Processamento e Política de Falha

**Description:** Consome `process-video` no worker. Extrai metadados, gera thumbnail e playback, e leva o vídeo a `ready`. Erros transitórios são re-tentados; erros permanentes falham na hora. O estado terminal (`ready` ou `failed` com motivo) é sempre alcançado.

**Technical actions:**

1. Criar `src/videos/processing/video.processor.ts` — `@Processor(VIDEO_PROCESSING_QUEUE)` estendendo `WorkerHost`, registrado **só** no `WorkerModule` (per `phase-03-videos/TD-02`, `phase-03-videos/TD-03`). `process(job)`:
   1. carrega o vídeo; se não estiver `processing`, retorna sem efeito (idempotência);
   2. `probe` via `presignInternalGet(original_key)`;
   3. `extractThumbnail`;
   4. baixa o original para o volume temporário do worker e roda `normalizeForPlayback`.

   (per `phase-03-videos/TD-09`, `phase-03-videos/TD-10`, `phase-03-videos/TD-13`)
2. Publicar as saídas sobrescrevendo de forma idempotente a cada tentativa: `thumbnails/{id}.jpg` e `playback/{id}.mp4` via `putObjectFromFile`. Depois, update condicional para `ready` gravando `duration_seconds`, `width`, `height`, `video_codec`, `audio_codec`, `thumbnail_key` e `playback_key`. O original é mantido, e os arquivos temporários são limpos em `finally` (per `phase-03-videos/TD-10` Revision).
3. Classificar erros no `process` (per `phase-03-videos/TD-15`; ver `library-refs.md` → `bullmq`):
   - `PermanentMediaError` → `throw new UnrecoverableError('not_a_video')`;
   - qualquer outro erro é relançado como está, para o BullMQ re-tentar com `processingJobOptions` (3 tentativas, backoff exponencial).
4. Criar o hook de falha final com `@OnWorkerEvent('failed')`. Ele só age quando `err instanceof UnrecoverableError` ou `job.attemptsMade >= (job.opts.attempts ?? 1)`: faz update condicional para `failed`, com `failure_reason` `not_a_video` ou `processing_failed` (per `phase-03-videos/TD-15`).
5. Montar um volume temporário dedicado (`tmpfs` ou volume nomeado) no serviço `video-worker` do `compose.yaml` para os downloads do original.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessor.process` | Unit: `PermanentMediaError` → `UnrecoverableError`; erro de rede → relançado como retryable; vídeo fora de `processing` → no-op (mocks dos colaboradores) | `src/videos/processing/video.processor.spec.ts` |
| `VideoProcessor` + hook `failed` | Integration (Redis worker real + Postgres + MinIO + FFmpeg, backoff de poucos ms, `waitUntilFinished` + polling do banco): fixture MP4 → `ready` com metadados e objetos em `playback/` e `thumbnails/`; bytes aleatórios → 1 tentativa só, `failed`/`not_a_video`; falha transitória de upload (colaborador sobrescrito para falhar 1 vez) → re-tenta e fica `ready`; falha transitória persistente → `failed`/`processing_failed` só após a 3ª tentativa | `src/videos/processing/video.processor.integration-spec.ts` |

**Dependencies:** SI-03.4 (worker + fila), SI-03.8 (vídeos chegam a `processing` com job enfileirado), SI-03.9 (`FfmpegService`)

**Acceptance criteria:**

- Um vídeo válido enfileirado em `processing` termina `ready`, com `duration_seconds`, `width`, `height` e codecs preenchidos, e com `playback/{id}.mp4` e `thumbnails/{id}.jpg` no bucket.
- Depois de `ready`, o original continua em `originals/{id}/`.
- Um arquivo que não é vídeo termina `failed` com `failure_reason: "not_a_video"` após uma única tentativa.
- Uma falha transitória que se resolve na 2ª tentativa termina em `ready`, e o vídeo nunca passa por `failed`.
- Uma falha transitória que persiste termina `failed` com `failure_reason: "processing_failed"` só depois da última tentativa; nas tentativas intermediárias o status continua `processing`.
- Re-executar o job de um vídeo já `ready` não altera a linha nem os objetos.

---

### SI-03.11 — Varredura de Uploads Parados (Job Scheduler na Fila maintenance)

**Description:** Garante que rascunhos abandonados no meio do upload cheguem a um estado terminal no banco (`failed`/`upload_expired`) depois de 24 h. Usa um job scheduler do BullMQ que roda uma vez por hora, independente do número de réplicas.

**Technical actions:**

1. Criar `src/videos/maintenance/stale-upload-sweep.service.ts` → `markStaleUploads(now: Date)`. Faz um único `UPDATE videos SET processing_status = 'failed', failure_reason = 'upload_expired' WHERE processing_status = 'uploading' AND created_at < now - interval '24 hours'` e retorna a contagem. O relógio é injetado, e o update é condicional por causa da corrida com o consumidor de eventos (per `phase-03-videos/TD-07` Revision, `phase-03-videos/TD-16`).
2. Criar `src/videos/maintenance/maintenance.processor.ts` — `@Processor(MAINTENANCE_QUEUE)` estendendo `WorkerHost`, registrado só no `WorkerModule`. Trata `SWEEP_STALE_UPLOADS_JOB` chamando `markStaleUploads(new Date())` (per `phase-03-videos/TD-16`).
3. Criar `src/videos/maintenance/stale-upload-sweep.scheduler.ts`. No `onApplicationBootstrap` do worker, chama `maintenanceQueue.upsertJobScheduler('stale-upload-sweep', { every: 3600000 }, { name: SWEEP_STALE_UPLOADS_JOB })`. O upsert é idempotente entre reboots e réplicas (per `phase-03-videos/TD-16`; ver `library-refs.md` → `bullmq`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StaleUploadSweepService.markStaleUploads` | Integration (Postgres real, relógio injetado): `uploading` com 25 h → `failed`/`upload_expired`; `uploading` com 1 h → intacto; `processing` com 25 h → intacto; linha movida para `processing` antes da varredura não é tocada | `src/videos/maintenance/stale-upload-sweep.service.integration-spec.ts` |
| Scheduler `stale-upload-sweep` | Integration (Redis real): registrar duas vezes deixa exatamente 1 scheduler com `every = 3600000` | `src/videos/maintenance/stale-upload-sweep.scheduler.integration-spec.ts` |

**Dependencies:** SI-03.4 (fila `maintenance` + `WorkerModule`), SI-03.5 (tabela `videos`)

**Acceptance criteria:**

- Um vídeo em `uploading` criado há mais de 24 h fica `failed` com `failure_reason: "upload_expired"` após a varredura.
- Vídeos em `uploading` há menos de 24 h e vídeos em qualquer outro status não são alterados pela varredura.
- Com dois workers subindo, a fila `maintenance` tem um único job scheduler `stale-upload-sweep` com intervalo de 1 h.

---

### SI-03.12 — Endpoints de Status, Playback (Streaming) e Download

**Route:** GET /videos/:publicId; GET /videos/:publicId/playback-url; GET /videos/:publicId/download-url
**Test Specs:** _pending /plan-test-specs_
**Authorization:** Owner (não-dono recebe `404 VIDEO_NOT_FOUND`)

**Description:** Expõe ao dono o status do processamento (para polling) e emite URLs presigned de curta duração. A de playback permite streaming por Range, sem baixar o arquivo inteiro; a de download serve o arquivo original.

**Technical actions:**

1. Criar `VideosService.getOwnedVideo(userId, publicId)`, que monta a resposta de `### API Contracts → GET /videos/:publicId`. `thumbnail_url` vem de `StorageService.publicObjectUrl(thumbnail_key)`, só quando `ready`; senão é `null` (per `phase-03-videos/TD-11`, `phase-03-videos/TD-14`).
2. Criar `VideosService.getPlaybackUrl(userId, publicId)`: exige `ready` (senão lança `VideoNotReadyException`) e devolve `presignGet(playback_key)` com `expires_in` (per `phase-03-videos/TD-10`, `phase-03-videos/TD-11` Revision).
3. Criar `VideosService.getDownloadUrl(userId, publicId)` (per `phase-03-videos/TD-10` Revision, `phase-03-videos/TD-11` Revision):
   - exige `ready` (decisão do plano em `### API Contracts → GET /videos/:publicId/download-url`);
   - devolve `presignGet(original_key, responseContentDisposition: 'attachment; filename="<title>.<ext>"')`;
   - o nome do arquivo é sanitizado para o header.
4. Adicionar as três rotas ao `VideosController` com as respostas `200` de `### API Contracts`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService` (status/delivery) | Unit: `thumbnail_url` nulo fora de `ready`; playback/download fora de `ready` → `VIDEO_NOT_READY`; `filename` do download sanitizado (aspas, quebras de linha) | `src/videos/videos.service.spec.ts` (estender) |
| `VideosService` (status/delivery) | Integration (Postgres + MinIO reais, vídeo `ready` semeado com objetos): URL de playback assinada internamente atende `Range: bytes=0-1023` com `206`; URL de download assinada internamente responde com `Content-Disposition: attachment`; URLs públicas têm a origem de `S3_PUBLIC_ENDPOINT` | `src/videos/videos.service.integration-spec.ts` (estender) |

**Dependencies:** SI-03.3 (`StorageService`), SI-03.5 (entidade `Video`)

**Acceptance criteria:**

- `GET /videos/:publicId` do dono retorna `200` com `processing_status`, `failure_reason`, `published_at: null` e `thumbnail_url: null` enquanto o vídeo não está `ready`.
- `GET /videos/:publicId` de um vídeo `ready` retorna `thumbnail_url` acessível sem autenticação e `duration_seconds` preenchido.
- `GET /videos/:publicId/playback-url` de um vídeo `ready` retorna `200` com `url`. Um `GET` nessa `url` com `Range: bytes=0-1023` responde `206 Partial Content`.
- `GET /videos/:publicId/download-url` de um vídeo `ready` retorna `200` com uma `url` cuja resposta traz `Content-Disposition: attachment; filename="<title>.<ext>"` e o arquivo original.
- `GET /videos/:publicId/playback-url` ou `/download-url` de um vídeo que não está `ready` retorna `409` com `VIDEO_NOT_READY`.
- Qualquer uma das três rotas chamada por quem não é dono retorna `404` com `VIDEO_NOT_FOUND`, a mesma resposta de um `publicId` inexistente.

---

### SI-03.13 — Documentação OpenAPI dos Endpoints de Vídeo e Sincronização do Contrato

**Description:** Documenta os novos endpoints públicos no `openapi.json` com respostas tipadas por status e o envelope de erro, como exigem as decisões de OpenAPI herdadas. Depois sincroniza o contrato commitado no `next-frontend`, única alteração nesse subprojeto na Fase 03.

**Technical actions:**

1. Anotar `VideosController` e os DTOs com decoradores explícitos (`@ApiTags('videos')`, `@ApiBearerAuth()`, `@ApiOperation`, `@ApiResponse`/`@ApiCreatedResponse`/`@ApiAcceptedResponse` por status, e `@ApiParam('publicId')`). Criar DTOs de resposta (`VideoResponseDto`, `UploadInitResponseDto`, `PartUrlsResponseDto`, `UploadedPartsResponseDto`, `MediaUrlResponseDto`). As respostas de erro referenciam o envelope existente `api-error-envelope.dto.ts` (per `openapi-docs-nestjs/TD-01` Revision).
2. Confirmar que `POST /internal/storage-events` está excluído do documento (`@ApiExcludeEndpoint()`, SI-03.8) e que a Swagger UI continua só em dev/staging (per `openapi-docs-nestjs/TD-03`).
3. Regenerar o artefato com `docker compose exec nestjs-api npm run openapi:export` e commitar `nestjs-project/openapi.json` (per `openapi-docs-nestjs/TD-02`).
4. No host, rodar `scripts/sync-openapi.sh` e depois `npm run openapi:types` em `next-frontend`, commitando `next-frontend/openapi.json` e `next-frontend/lib/api/types.gen.ts`. Essa é a única mudança em `next-frontend` na fase (per `next-frontend-openapi-typing/TD-02`, `next-frontend-openapi-typing/TD-03`; resolução AMB-1 em `context.md`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Documento OpenAPI | Integration: o documento gerado contém os 7 paths públicos de vídeo com os status de `### API Contracts`, não contém `/internal/storage-events`, e o artefato commitado bate com o gerado | `src/openapi-export.integration-spec.ts` (estender) |

**Dependencies:** SI-03.6, SI-03.7, SI-03.8, SI-03.12 (todos os endpoints existem)

**Acceptance criteria:**

- `nestjs-project/openapi.json` lista `POST /videos`, as três rotas de upload e as três de status/entrega, cada uma com seus códigos de resposta e o envelope de erro nos `4xx`.
- `/internal/storage-events` não aparece em `nestjs-project/openapi.json` nem na Swagger UI.
- `next-frontend/openapi.json` é idêntico a `nestjs-project/openapi.json`, e `next-frontend/lib/api/types.gen.ts` contém os paths `/videos`.
- Nenhum outro arquivo de `next-frontend/` é alterado na fase.

---

### SI-03.14 — Verificação Ponta a Ponta do Pipeline de Vídeo

**Description:** Prova o fluxo completo da fase com a infra real do Compose, num único teste e2e: rascunho → upload direto ao storage → evento → processamento no worker → `ready` → streaming por Range e download. Inclui também o caminho de erro.

**Technical actions:**

1. Adicionar `prefix` ao `queueConfig` (env `QUEUE_PREFIX`, default `bull`) e repassá-lo ao `BullModule.forRootAsync`. Com isso o teste isola suas chaves do worker que roda no container `video-worker` (per `phase-03-videos/TD-02`; testing guide → BullMQ `prefix` por arquivo).
2. Criar `test/videos-pipeline.e2e-spec.ts`, com este setup:
   - sobe o `AppModule` reproduzindo a config global de `main.ts`;
   - sobe o `WorkerModule` in-process com o mesmo `prefix` único;
   - antes do bootstrap, define `S3_PUBLIC_ENDPOINT=http://minio:9000`, para que as URLs presigned sejam alcançáveis de dentro do container;
   - cria e confirma um usuário com os fluxos de auth existentes.
3. Caminho feliz:
   1. `POST /videos` com uma fixture MP4 gerada por `src/test/media.ts`;
   2. assinar as partes, fazer `PUT` delas e `POST .../upload/complete`;
   3. entregar o evento `s3:ObjectCreated:CompleteMultipartUpload` (tamanho real via `HeadObject`) em `POST /internal/storage-events` com o token;
   4. fazer polling em `GET /videos/:publicId` até `ready`, com timeout;
   5. `GET .../playback-url` + `Range: bytes=0-1023` → `206`;
   6. `GET .../download-url` → `Content-Disposition: attachment` e bytes iguais aos do upload.
4. Caminho de erro: os mesmos passos com um arquivo de bytes aleatórios declarado `video/mp4`. `GET /videos/:publicId` termina `failed` com `failure_reason: "not_a_video"`, e `playback-url` responde `409 VIDEO_NOT_READY`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Pipeline de vídeo (API + worker + MinIO + Redis + Postgres) | E2E (supertest, infra real do Compose): caminho feliz até streaming/download; caminho `not_a_video` | `test/videos-pipeline.e2e-spec.ts` |

**Dependencies:** SI-03.8 (evento → `processing` + job), SI-03.10 (worker leva a `ready`/`failed`), SI-03.12 (status, playback e download)

**Acceptance criteria:**

- Um vídeo enviado direto ao storage em partes presigned chega a `ready` sem que nenhum byte do arquivo passe pela API, e o banco registra a sequência `uploading` → `processing` → `ready`.
- Para o vídeo `ready`, a URL de playback responde `206 Partial Content` a uma requisição com `Range`, e a URL de download entrega exatamente os bytes enviados com `Content-Disposition: attachment`.
- Um arquivo que não é vídeo termina `failed` com `failure_reason: "not_a_video"` visível em `GET /videos/:publicId`.
- O teste não deixa jobs, objetos nem linhas para trás: bucket esvaziado, fila com o `prefix` do teste obliterada e tabelas limpas no teardown.

---

### SI-03.15 — Atualizar CLAUDE.md com a Seção de Vídeos

**Description:** Atualiza a documentação de IA (`CLAUDE.md` raiz e `nestjs-project/CLAUDE.md`) para refletir o estado real do código após a fase: módulo de vídeos, endpoints, fila e worker, e storage. É feito por último, para citar só arquivos e comportamentos que existem.

**Technical actions:**

1. No `CLAUDE.md` raiz:
   - trocar `**Message Queue** (TBD)` por `**Message Queue** (BullMQ + Redis)` (per `phase-03-videos/TD-02`);
   - registrar o container `video-worker` e o object storage MinIO (dev) / S3 (prod) na seção de arquitetura (per `phase-03-videos/TD-01`, `phase-03-videos/TD-03`).
2. Em `nestjs-project/CLAUDE.md` → `## Development Environment` / `## Environment Startup Verification`, listar os serviços `minio`, `minio-init`, `redis` e `video-worker`, com as verificações de prontidão:
   - `docker compose ps` com `minio`/`redis` healthy;
   - `minio-init` concluído;
   - log do `video-worker` com o contexto iniciado.
3. Adicionar `## Videos` a `nestjs-project/CLAUDE.md`, cobrindo:
   - layout do módulo (`src/videos/`, `src/storage/`, `src/queue/`, `src/worker.ts`);
   - os 7 endpoints públicos e o webhook interno, com o mecanismo de autenticação de cada um;
   - ciclo de status e `failure_reason`;
   - chaves do bucket (`originals/`, `playback/`, `thumbnails/`);
   - filas `video-processing`/`maintenance` e o scheduler `stale-upload-sweep`;
   - variáveis de ambiente, incluindo a exceção `S3_PUBLIC_ENDPOINT`.
4. Documentar em `nestjs-project/CLAUDE.md` → `### Test execution` como os testes usam MinIO e Redis reais (bucket de teste, `prefix` BullMQ, `S3_PUBLIC_ENDPOINT` interno em e2e) e como rodar o worker (`npm run start:worker:dev`).

**Tests:** _(empty — documentation SI; verified by the acceptance criteria)_

**Dependencies:** SI-03.13, SI-03.14 (código e contrato finais)

**Acceptance criteria:**

- Todo caminho de arquivo, script npm, serviço do Compose, endpoint e variável de ambiente citado nas seções novas existe no repositório. Não há referência a artefato inexistente.
- O `CLAUDE.md` raiz não descreve mais a fila como "TBD".
- Seguir só `nestjs-project/CLAUDE.md` basta para subir a stack completa (API, banco, Mailpit, MinIO, Redis, worker) e verificar a prontidão de cada serviço.

---

## Technical Specifications

### Data Model

#### Video

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK, generated | Internal identifier. Used in storage object keys; never exposed in URLs |
| public_id | varchar(11) | unique, not null | Random 11-char base64url (`node:crypto`), generated at pre-registration; retry on unique violation (per phase-03-videos/TD-12) |
| channel_id | uuid | FK → channels.id, not null | Owner channel (the authenticated user's channel) |
| title | varchar(100) | not null | 1–100 chars; defaults to the filename without extension, truncated to 100 (per phase-03-videos/TD-07 Revision) |
| original_filename | varchar(255) | not null | As declared at init; used for the download `filename` |
| mime_type | varchar(100) | not null | One of `video/mp4`, `video/quicktime`, `video/webm`, `video/x-matroska` (per phase-03-videos/TD-07 Revision) |
| declared_size | bigint | not null | Bytes declared at init; ≤ 10 737 418 240 (per phase-03-videos/TD-07) |
| size | bigint | nullable | Verified size from the storage event + `HeadObject` (per phase-03-videos/TD-07 Revision) |
| processing_status | enum `video_processing_status` | not null, default `'uploading'`, values: `'uploading'`, `'processing'`, `'ready'`, `'failed'` | Processing axis (per phase-03-videos/TD-05) |
| failure_reason | varchar(64) | nullable | Machine-readable reason, set only when `processing_status = 'failed'` (per phase-03-videos/TD-15, phase-03-videos/TD-16). Values: `upload_expired`, `file_too_large`, `not_a_video`, `processing_failed` |
| published_at | timestamptz | nullable, default null | Publication axis: `NULL` = draft ("rascunho"). No transitions in Phase 03; owned by Phase 04 (per phase-03-videos/TD-05 Revision) |
| upload_id | varchar(255) | nullable | S3 multipart `UploadId` while `uploading`; cleared when the storage event confirms the upload (per phase-03-videos/TD-04, phase-03-videos/TD-06 Revision). Abandoned multipart uploads are reclaimed by the bucket lifecycle rule `AbortIncompleteMultipartUpload` after 1 day, and their rows by the 24 h sweep (per phase-03-videos/TD-07 Revision, phase-03-videos/TD-16) |
| original_key | varchar(512) | not null | `originals/{id}/source{ext}`. The kept original is the download source (per phase-03-videos/TD-10 Revision) |
| playback_key | varchar(512) | nullable | `playback/{id}.mp4`, the faststart H.264/AAC MP4 and only streaming source (per phase-03-videos/TD-10) |
| thumbnail_key | varchar(512) | nullable | `thumbnails/{id}.jpg` under the public-read prefix, JPEG 1280px wide (per phase-03-videos/TD-11, phase-03-videos/TD-13) |
| duration_seconds | numeric(12,3) | nullable | From `ffprobe` `format.duration` |
| width | integer | nullable | From the first video stream |
| height | integer | nullable | From the first video stream |
| video_codec | varchar(32) | nullable | From the first video stream `codec_name` |
| audio_codec | varchar(32) | nullable | From the first audio stream `codec_name`, if any |
| created_at | timestamptz | not null, auto-generated | `@CreateDateColumn`. Also the age reference for the 24 h stale-upload sweep (per phase-03-videos/TD-16) |
| updated_at | timestamptz | not null, auto-generated | `@UpdateDateColumn` |

**Status cycle (per phase-03-videos/TD-05 Revision):**
- "rascunho" = `published_at IS NULL` while `processing_status = 'uploading'`.
- "processando" = `processing_status = 'processing'`.
- "pronto/erro" = `processing_status = 'ready' | 'failed'`.

All transitions out of `uploading` are **conditional updates** (`WHERE processing_status = 'uploading'`), because the storage-event consumer and the stale-upload sweep can race (per phase-03-videos/TD-16).

**Relations:** Video → Channel (many-to-one, via `channel_id`; no cascade). `Channel` gets no inverse relation in this phase.
**Indexes:** `(public_id)` — unique; `(channel_id)` — FK; `(processing_status, created_at)` — for the stale-upload sweep query.
**Migration:** one TypeORM migration, `src/database/migrations/<timestamp>-CreateVideos.ts` (name per the challenge brief's deliverable structure), creating the `video_processing_status` enum type and the `videos` table (`synchronize` stays off, per inherited convention).

**Storage keys (per phase-03-videos/TD-01 Revision):** a single bucket (`S3_BUCKET`), with the prefixes `originals/`, `playback/` and `thumbnails/` (public-read) as listed in the key columns above.

### API Contracts

All `/videos` routes require the existing global `JwtAuthGuard` (`Authorization: Bearer <access_token>`, per phase-02-auth/TD-02) and are exempt from the global throttler with `@SkipThrottle()`. Part signing (up to 160 parts), resume and status polling would otherwise hit the 10 req/min auth limit (per phase-02-auth/TD-08: throttling is meant for auth, exemptions via `@SkipThrottle()`). Errors use the inherited `{ statusCode, error, message }` envelope (per phase-02-auth/TD-07). JSON fields are snake_case, matching existing endpoints. `:publicId` is the 11-char `public_id` (per phase-03-videos/TD-12). A video that does not exist **or** belongs to another channel answers `404 VIDEO_NOT_FOUND`, so drafts never leak existence.

#### POST /videos (SI-03.6)

Pre-registers the video as a draft and starts the S3 multipart upload (per phase-03-videos/TD-04, phase-03-videos/TD-05, phase-03-videos/TD-07).

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer <access_token>

**Request body:**
- filename: string, required — 1–255 chars
- size: integer, required — bytes, 1 ≤ size ≤ 10 737 418 240
- mime_type: string, required — one of `video/mp4`, `video/quicktime`, `video/webm`, `video/x-matroska`
- title: string, optional — 1–100 chars; defaults to `filename` without extension, truncated to 100

**Response 201:**
- public_id: string (11 chars)
- title: string
- processing_status: `"uploading"`
- upload: object
  - part_size: integer — always `67108864` (64 MiB, server-owned)
  - part_count: integer — `ceil(size / part_size)` (≤ 160)

**Error responses:**
- 400 validation error: body fails schema validation (missing field, size out of range, MIME outside allowlist, title out of range)

---

#### POST /videos/:publicId/upload/part-urls (SI-03.7)

Signs presigned `UploadPart` URLs in batches. They are signed against `S3_PUBLIC_ENDPOINT` so the browser can PUT bytes directly to storage (per phase-03-videos/TD-04, phase-03-videos/TD-11).

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer <access_token>

**Request body:**
- part_numbers: integer[], required — 1–100 entries, each `1 ≤ n ≤ part_count`, unique

**Response 200:**
- urls: array of `{ part_number: integer, url: string }`
- expires_in: integer — `3600` seconds (per phase-03-videos/TD-07 Revision)

**Error responses:**
- 404 VIDEO_NOT_FOUND: unknown `publicId` or not owned by the caller
- 409 INVALID_UPLOAD_STATE: video is not `uploading` or has no active `upload_id`
- 400 INVALID_PART_NUMBER: a part number is outside `1..part_count`
- 400 validation error: body fails schema validation

---

#### GET /videos/:publicId/upload/parts (SI-03.7)

Lists the parts already stored (S3 `ListParts`) so a client can resume (per phase-03-videos/TD-04).

**Request headers:**
- Authorization: Bearer <access_token>

**Response 200:**
- part_size: integer
- part_count: integer
- parts: array of `{ part_number: integer, etag: string, size: integer }`

**Error responses:**
- 404 VIDEO_NOT_FOUND: unknown `publicId` or not owned by the caller
- 409 INVALID_UPLOAD_STATE: video is not `uploading` or has no active `upload_id`

---

#### POST /videos/:publicId/upload/complete (SI-03.7)

Runs `CompleteMultipartUpload` and returns `202`. It does **not** enqueue processing and does **not** verify size: both happen in the storage-event consumer (per phase-03-videos/TD-04 Revision, phase-03-videos/TD-06 Revision, phase-03-videos/TD-07 Revision).

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer <access_token>

**Request body:**
- parts: array, required — 1..`part_count` entries of `{ part_number: integer (1..part_count), etag: string }`, ascending by `part_number`

**Response 202:**
- public_id: string
- processing_status: `"uploading"`. It moves to `processing` once the storage event is consumed.

**Error responses:**
- 404 VIDEO_NOT_FOUND: unknown `publicId` or not owned by the caller
- 409 INVALID_UPLOAD_STATE: video is not `uploading` or has no active `upload_id`
- 400 INVALID_UPLOAD_PARTS: storage rejected the part list (missing part, wrong ETag, part smaller than 5 MiB except the last)
- 400 validation error: body fails schema validation

---

#### GET /videos/:publicId (SI-03.12)

Owner-only read of a video and its processing status. The FE polls this through the BFF while `uploading`/`processing`; the BFF is deferred to Phases 04/05 (per phase-03-videos/TD-14).

**Request headers:**
- Authorization: Bearer <access_token>

**Response 200:**
- public_id: string
- title: string
- processing_status: `"uploading" | "processing" | "ready" | "failed"`
- failure_reason: string | null
- published_at: string (ISO-8601) | null — always `null` in Phase 03
- duration_seconds: number | null
- width: integer | null
- height: integer | null
- thumbnail_url: string | null — public, cacheable URL under the public-read prefix, built from `S3_PUBLIC_ENDPOINT` (per phase-03-videos/TD-11); `null` until `ready`
- created_at: string (ISO-8601)

**Error responses:**
- 404 VIDEO_NOT_FOUND: unknown `publicId` or not owned by the caller

---

#### GET /videos/:publicId/playback-url (SI-03.12)

Issues a short-lived presigned GET for `playback.mp4`. Streaming works through HTTP Range against that URL (`Range: bytes=…` → `206 Partial Content`) (per phase-03-videos/TD-10, phase-03-videos/TD-11 Revision).

**Request headers:**
- Authorization: Bearer <access_token>

**Response 200:**
- url: string — presigned GET signed against `S3_PUBLIC_ENDPOINT`
- expires_in: integer — seconds (from storage config)

**Error responses:**
- 404 VIDEO_NOT_FOUND: unknown `publicId` or not owned by the caller
- 409 VIDEO_NOT_READY: `processing_status` is not `ready`

---

#### GET /videos/:publicId/download-url (SI-03.12)

Issues a short-lived presigned GET for the **original** upload with `ResponseContentDisposition=attachment; filename="<title>.<ext>"` (per phase-03-videos/TD-10 Revision, phase-03-videos/TD-11 Revision).

**Request headers:**
- Authorization: Bearer <access_token>

**Response 200:**
- url: string — presigned GET signed against `S3_PUBLIC_ENDPOINT`, carrying `response-content-disposition`
- expires_in: integer — seconds (from storage config)

**Error responses:**
- 404 VIDEO_NOT_FOUND: unknown `publicId` or not owned by the caller
- 409 VIDEO_NOT_READY: `processing_status` is not `ready`. This is a plan decision: phase-03-videos/TD-11 Revision gates only playback, and this plan applies the same gate to download so only files that passed `ffprobe` validation are offered (an upload can still fail `not_a_video` while `processing`).

---

#### POST /internal/storage-events (SI-03.8)

Internal webhook fed by the bucket notification `s3:ObjectCreated:CompleteMultipartUpload` on the `originals/` prefix (MinIO `notify_webhook` target in dev; an S3 → SQS/EventBridge adapter in prod; per phase-03-videos/TD-06 Revision). It is marked `@Public()` (outside the global JWT guard), `@SkipThrottle()`, protected by `StorageWebhookTokenGuard`, and excluded from the public OpenAPI document (`@ApiExcludeEndpoint()`).

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer <STORAGE_WEBHOOK_TOKEN> — the shared token from env, compared in constant time

**Request body:** S3 event notification JSON. Fields used:
- EventName: string — only `s3:ObjectCreated:CompleteMultipartUpload` is processed; others are acknowledged and ignored
- Records[].s3.object.key: string — URL-encoded object key `originals/{videoId}/source{ext}`
- Records[].s3.object.size: integer — bytes

**Response 204:** No content. Duplicate events are also acknowledged with 204, because the consumer is idempotent.

**Side effects (consumer, per record):**
1. Resolve the video from the key.
2. Verify `size` with `HeadObject`. If oversize (> 10 737 418 240, or > `declared_size`): delete the object and set `failed` + `file_too_large`.
3. Otherwise: persist `size`, clear `upload_id`, and move `processing_status` `uploading → processing` (conditional update).
4. Enqueue `process-video` with `jobId = videoId`.

**Error responses:**
- 401 INVALID_WEBHOOK_TOKEN: missing or wrong shared token
- 400 validation error: body is not a parseable S3 event

---

#### Validation Rules — upload control plane

- `filename`: required, string, 1–255 chars
- `size`: required, integer, `1 ≤ size ≤ 10737418240`
- `mime_type`: required, `IsIn([video/mp4, video/quicktime, video/webm, video/x-matroska])`
- `title`: optional, string, trimmed, 1–100 chars
- `part_numbers`: required, array of 1–100 unique integers ≥ 1. The upper bound (`part_count`) is checked in the service → `INVALID_PART_NUMBER`
- `parts`: required, non-empty array of `{ part_number: integer ≥ 1, etag: non-empty string }`

### Authorization Matrix

In Phase 03 every video is a draft, so all video reads and URLs are owner-only; anonymous access arrives in Phase 05 (per phase-03-videos/TD-11 Revision). "Owner" = the authenticated user whose channel (`channels.user_id`) matches `videos.channel_id`. A non-owner gets the same `404 VIDEO_NOT_FOUND` as a missing video.

| Endpoint | Anonymous | Authenticated | Owner | Storage webhook token |
|----------|-----------|---------------|-------|-----------------------|
| POST /videos | ✗ | ✓ (video created in the caller's channel) | — | ✗ |
| POST /videos/:publicId/upload/part-urls | ✗ | ✗ | ✓ | ✗ |
| GET /videos/:publicId/upload/parts | ✗ | ✗ | ✓ | ✗ |
| POST /videos/:publicId/upload/complete | ✗ | ✗ | ✓ | ✗ |
| GET /videos/:publicId | ✗ | ✗ | ✓ | ✗ |
| GET /videos/:publicId/playback-url | ✗ | ✗ | ✓ | ✗ |
| GET /videos/:publicId/download-url | ✗ | ✗ | ✓ | ✗ |
| POST /internal/storage-events | ✗ | ✗ | ✗ | ✓ (only) |

Direct storage access: presigned URLs (part PUT, playback GET, download GET) are capability URLs. They are issued only through the owner-only endpoints above and expire: parts after 1 h (per phase-03-videos/TD-07 Revision), playback and download after the configured short TTL. Thumbnails live under a public-read prefix and are intentionally readable without auth (per phase-03-videos/TD-11).

### Error Catalog

New codes follow the existing `DomainException(errorCode, httpStatus, message)` pattern, mapped by the inherited domain exception filter to `{ statusCode, error, message }` (per phase-02-auth/TD-07).

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| VIDEO_NOT_FOUND | 404 | `publicId` does not exist, or belongs to another user's channel |
| INVALID_UPLOAD_STATE | 409 | Upload control-plane call when the video is not `uploading` or has no active `upload_id` |
| INVALID_PART_NUMBER | 400 | A requested part number is outside `1..part_count` |
| INVALID_UPLOAD_PARTS | 400 | Storage rejected `CompleteMultipartUpload` (missing part, ETag mismatch, undersized non-final part) |
| VIDEO_NOT_READY | 409 | Playback or download URL requested while `processing_status` is not `ready` |
| INVALID_WEBHOOK_TOKEN | 401 | Storage-event webhook called without the correct shared token |

Processing failures are **not** HTTP errors. They are persisted as `processing_status = 'failed'` with `failure_reason` and read through `GET /videos/:publicId` (per phase-03-videos/TD-15):

| failure_reason | Set by | Trigger |
|----------------|--------|---------|
| `file_too_large` | Storage-event consumer | Verified object size > 10 737 418 240 bytes or > `declared_size`; object deleted (per phase-03-videos/TD-07 Revision) |
| `upload_expired` | Stale-upload sweep | Still `uploading` 24 h after `created_at` (per phase-03-videos/TD-16) |
| `not_a_video` | VideoProcessor (`UnrecoverableError`) | `ffprobe` finds no video stream, or the container is unreadable (permanent; no retry) |
| `processing_failed` | VideoProcessor final-failure hook | Transient errors exhausted all attempts |

### Events/Messages

#### s3:ObjectCreated:CompleteMultipartUpload

**Payload:** (fields used, from the S3 event notification)

```json
{ "EventName": "s3:ObjectCreated:CompleteMultipartUpload", "Records": [{ "s3": { "bucket": { "name": "string" }, "object": { "key": "originals/{videoId}/source.mp4", "size": 123456789 } } }] }
```

**Producer:** object storage bucket notification, for the `originals/` prefix only. In dev, MinIO's `notify_webhook` target points at `http://nestjs-api:3000/internal/storage-events`, configured in the Compose init step. In prod, an S3 → SQS/EventBridge adapter (per phase-03-videos/TD-06 Revision).
**Consumer:** `StorageEventsService` via `POST /internal/storage-events` (per phase-03-videos/TD-06)
**Trigger:** S3 finalizes a multipart upload after `POST /videos/:publicId/upload/complete`
**Delivery semantics:** at-least-once. Duplicates are absorbed by the conditional `uploading → processing` update plus `jobId = videoId` enqueue (per phase-03-videos/TD-06 Revision)

#### video-processing → process-video

**Payload:**

```json
{ "videoId": "uuid" }
```

**Producer:** `StorageEventsService` (API process) — `queue.add('process-video', { videoId }, { ...PROCESSING_JOB_OPTIONS, jobId: videoId })` (per phase-03-videos/TD-02, phase-03-videos/TD-06)
**Consumer:** `VideoProcessor` (`@Processor('video-processing')`, `WorkerHost`) in the `video-worker` container only (per phase-03-videos/TD-03)
**Trigger:** a verified upload moves to `processing`
**Delivery semantics:** at-least-once with idempotent re-runs. `PROCESSING_JOB_OPTIONS` = `attempts: 3`, `backoff: { type: 'exponential', delay: <config> }` (delay configurable so tests can shrink it). Permanent errors throw `UnrecoverableError` (no retry → `not_a_video`). The final-failure hook (last attempt or `UnrecoverableError`) sets `failed` + `failure_reason` (per phase-03-videos/TD-15).
**Pipeline (per job):**
1. `ffprobe` via presigned internal URL (Range reads) → duration and metadata (per phase-03-videos/TD-08, phase-03-videos/TD-09).
2. Thumbnail: seek + `thumbnail` filter, `scale=1280:-2`, JPEG → `thumbnails/{id}.jpg` (per phase-03-videos/TD-13).
3. Download the original to a temp volume only when normalization needs it, then remux or transcode to H.264/AAC MP4 with `-movflags +faststart` → `playback/{id}.mp4` (per phase-03-videos/TD-09, phase-03-videos/TD-10).
4. Set `ready`, persist metadata and keys, clean the temp files. The original is kept (per phase-03-videos/TD-10 Revision).

#### maintenance → sweep-stale-uploads (job scheduler `stale-upload-sweep`)

**Payload:**

```json
{}
```

**Producer:** BullMQ job scheduler, `queue.upsertJobScheduler('stale-upload-sweep', { every: 3600000 }, { name: 'sweep-stale-uploads' })`, registered idempotently at worker bootstrap (per phase-03-videos/TD-16)
**Consumer:** `MaintenanceProcessor` (`@Processor('maintenance')`) in the `video-worker` container → `StaleUploadSweepService.markStaleUploads(now)` (per phase-03-videos/TD-16)
**Trigger:** every 1 h. The first run is immediate when the scheduler is first created. Videos still `uploading` 24 h after `created_at` are set to `failed` with `failure_reason = 'upload_expired'` (conditional update; per phase-03-videos/TD-07 Revision, phase-03-videos/TD-16)
**Delivery semantics:** once per tick across replicas (one scheduler in Redis), on a dedicated queue so the sweep never waits behind FFmpeg jobs (per phase-03-videos/TD-16)

---

## Dependency Map

```
SI-03.1 (root) — dependências + config + env
└── SI-03.2 — depends on SI-03.1 (Compose usa as chaves de env)
    ├── SI-03.3 — depends on SI-03.1, SI-03.2 (cliente S3 + MinIO no ar)
    │   └── SI-03.4 — depends on SI-03.1, SI-03.2, SI-03.3 (fila + worker importa StorageModule)
    │       ├── SI-03.5 — depends on SI-03.4 (Video registrado no WorkerModule)
    │       │   ├── SI-03.6 — depends on SI-03.3, SI-03.5 (rascunho + CreateMultipartUpload)
    │       │   │   └── SI-03.7 — depends on SI-03.6 (partes, retomada e complete)
    │       │   │       └── SI-03.8 — depends on SI-03.4, SI-03.7 (evento do complete → processing + job)
    │       │   ├── SI-03.11 — depends on SI-03.4, SI-03.5 (scheduler na fila maintenance + tabela videos)
    │       │   └── SI-03.12 — depends on SI-03.3, SI-03.5 (status + URLs presigned)
    │       └── SI-03.10 — depends on SI-03.4, SI-03.8, SI-03.9 (processor no worker)
    └── SI-03.9 — depends on SI-03.1, SI-03.2 (fluent-ffmpeg + FFmpeg na imagem)

SI-03.13 — depends on SI-03.6, SI-03.7, SI-03.8, SI-03.12 (todos os endpoints documentados e contrato sincronizado)
SI-03.14 — depends on SI-03.8, SI-03.10, SI-03.12 (pipeline completo e2e)
SI-03.15 — depends on SI-03.13, SI-03.14 (CLAUDE.md descreve o estado final)
```

Ordem de execução sugerida (respeita todas as arestas): 03.1 → 03.2 → 03.3 → 03.4 → 03.5 → 03.6 → 03.7 → 03.8 → 03.9 → 03.10 → 03.11 → 03.12 → 03.13 → 03.14 → 03.15.

---

## Deliverables

- [ ] SI-03.1 — Infra: Dependências, Namespaces de Configuração e Validação de Env
- [ ] SI-03.2 — Infra: Docker Compose com MinIO, Redis e FFmpeg na Imagem
- [ ] SI-03.3 — Módulo de Storage sobre a API S3
- [ ] SI-03.4 — Módulo de Fila e Entrypoint do Video Worker
- [ ] SI-03.5 — Entidade Video, Migration CreateVideos e Gerador de public_id
- [ ] SI-03.6 — Endpoint POST /videos: Pré-cadastro do Rascunho e Início do Multipart
- [ ] SI-03.7 — Endpoints do Plano de Controle do Upload: URLs de Parte, Partes Enviadas e Conclusão
- [ ] SI-03.8 — Webhook de Eventos do Storage, Verificação de Tamanho e Enfileiramento
- [ ] SI-03.9 — FfmpegService: Probe, Thumbnail e Normalização para Playback
- [ ] SI-03.10 — VideoProcessor: Pipeline de Processamento e Política de Falha
- [ ] SI-03.11 — Varredura de Uploads Parados (Job Scheduler na Fila maintenance)
- [ ] SI-03.12 — Endpoints de Status, Playback (Streaming) e Download
- [ ] SI-03.13 — Documentação OpenAPI dos Endpoints de Vídeo e Sincronização do Contrato
- [ ] SI-03.14 — Verificação Ponta a Ponta do Pipeline de Vídeo
- [ ] SI-03.15 — Atualizar CLAUDE.md com a Seção de Vídeos

**Phase artifacts:**

- [ ] `docs/phases/phase-03-videos/progress.md` mantido pelo `/implement`, com status e testes por SI
- [ ] Storage (`minio` + `minio-init`), fila (`redis`) e worker (`video-worker`) sobem com `docker compose up -d` junto com `nestjs-api`, `db` e `mailpit`
- [ ] Migration `src/database/migrations/<timestamp>-CreateVideos.ts` aplicada com `npm run migration:run`
- [ ] Trabalho feito em `feature/*` a partir de `dev` (Git Flow), sem commit direto na `main`

**Full test suites:**

- [ ] Backend tests pass (`cd nestjs-project && docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`cd nestjs-project && docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type/compilation checks pass (`cd nestjs-project && docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`cd nestjs-project && docker compose exec nestjs-api npm run lint`)
