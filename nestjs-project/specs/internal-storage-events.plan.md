---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.8
target_file: test/internal-storage-events.e2e-spec.ts
---

# POST /internal/storage-events — Test Plan

## Application Overview

`POST /internal/storage-events` é o webhook interno que recebe a notificação `s3:ObjectCreated:CompleteMultipartUpload` do bucket. A rota fica fora do guard JWT global (`@Public()`) e é protegida por um token compartilhado (`STORAGE_WEBHOOK_TOKEN`). O consumidor resolve o vídeo pela chave `originals/{videoId}/...` e confere o tamanho real com `HeadObject`:
- objeto acima do limite: remove o objeto e marca `failed`/`file_too_large`;
- caso contrário: move o vídeo de `uploading` para `processing` e enfileira `process-video` com `jobId = videoId`.

Eventos repetidos são idempotentes. Neste teste o evento é entregue pelo próprio teste, simulando o MinIO. A entrega real MinIO → API é verificada no ambiente de dev, porque o app de teste não escuta no host configurado no `notify_webhook`.

## Test Scenarios

### 1. Autenticar o webhook

**Setup:**
- antes do bootstrap, `process.env.QUEUE_PREFIX` recebe um valor único do arquivo; nenhum worker roda in-process, então os jobs ficam em `waiting` e podem ser inspecionados;
- sobe o `AppModule` reproduzindo a config global de `main.ts`;
- `beforeEach`: `cleanAllTables(dataSource)` + `emptyTestBucket()` + `queue.obliterate({ force: true })` na fila `video-processing`.

#### 1.1. rejeita-token-ausente-ou-errado

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-10-10T17:08:30Z

**Steps:**
  1. POST /internal/storage-events sem header `Authorization`, com um evento válido
    - expect: status `401` com `error` `"INVALID_WEBHOOK_TOKEN"`
  2. POST /internal/storage-events com `Authorization: Bearer wrong-token`
    - expect: status `401` com `error` `"INVALID_WEBHOOK_TOKEN"`
    - expect: nenhum vídeo muda de status e nenhum job é enfileirado

### 2. Processar a conclusão do upload

**Setup:** igual ao grupo 1. Um rascunho é criado via `POST /videos` (dono logado) com `size` de 1 MiB. Um objeto de 1 MiB é gravado em `originals/{videoId}/source.mp4` no bucket de teste. O evento é montado com `EventName: "s3:ObjectCreated:CompleteMultipartUpload"`, a chave URL-encoded e o `size` do objeto.

#### 2.1. evento-valido-promove-para-processing-e-enfileira-uma-vez

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-10-10T17:08:30Z

**Steps:**
  1. POST /internal/storage-events com `Authorization: Bearer <STORAGE_WEBHOOK_TOKEN>` e o evento montado
    - expect: status `204`
  2. Consultar o vídeo no banco
    - expect: `processing_status` é `processing`, `size` é `1048576` e `upload_id` é `NULL`
  3. Consultar a fila `video-processing`
    - expect: existe exatamente um job `process-video` em `waiting`, com `id` igual ao `id` do vídeo e `data` `{ "videoId": "<id>" }`

#### 2.2. evento-duplicado-nao-cria-segundo-job

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-10T17:08:30Z

**Steps:**
  1. Entregar o mesmo evento duas vezes em POST /internal/storage-events com o token correto
    - expect: as duas respostas têm status `204`
  2. Consultar a fila e o vídeo
    - expect: `getWaitingCount()` é `1`
    - expect: o vídeo continua `processing`, e `updated_at` não muda na segunda entrega

#### 2.3. objeto-acima-do-declarado-e-removido-e-marcado-file-too-large

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-10T17:08:30Z

**Steps:**
  1. Gravar em `originals/{videoId}/source.mp4` um objeto de 2 MiB (maior que o `declared_size` de 1 MiB) e entregar o evento correspondente com o token correto
    - expect: status `204`
  2. `HeadObject` na chave do original
    - expect: o objeto não existe mais (`404`/`NotFound`)
  3. Consultar o vídeo e a fila
    - expect: `processing_status` é `failed` e `failure_reason` é `file_too_large`
    - expect: nenhum job foi enfileirado

### 3. Manter o webhook fora do contrato público

**Setup:** gera o documento OpenAPI com o builder do projeto (`src/swagger/swagger-document.ts`) sobre o app de teste.

#### 3.1. rota-ausente-do-documento-openapi

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-10T17:08:30Z

**Steps:**
  1. Gerar o documento OpenAPI do app
    - expect: `paths` não contém `/internal/storage-events`
    - expect: `paths` contém `/videos` (controle positivo de que o documento inclui o módulo de vídeos)
