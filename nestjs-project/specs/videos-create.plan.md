---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.6
target_file: test/videos-create.e2e-spec.ts
---

# POST /videos — Test Plan

## Application Overview

`POST /videos` pré-cadastra um vídeo como rascunho (`processing_status: "uploading"`, `published_at` nulo) no canal do usuário autenticado e abre o upload multipart no object storage (MinIO). A resposta traz o `public_id` de 11 caracteres e o contrato de upload ditado pelo servidor (`part_size` de 64 MiB e `part_count`), para o cliente enviar os bytes direto ao storage, sem passar pela API. A rota exige o JWT global e é isenta do throttler de auth (`@SkipThrottle()`).

## Test Scenarios

### 1. Pré-cadastrar rascunho e iniciar o upload

**Setup:** sobe o `AppModule` via `Test.createTestingModule`, reproduzindo a config global de `main.ts` (`ValidationPipe` com `whitelist`/`forbidNonWhitelisted`/`transform`, `DomainExceptionFilter`, `ValidationExceptionFilter`). `beforeEach`: `cleanAllTables(dataSource)` + `emptyTestBucket()` (`src/test/s3.ts`). O usuário de teste é registrado, confirmado e logado pelos fluxos de auth existentes, e o `access_token` é usado como `Bearer`.

#### 1.1. cria-rascunho-e-retorna-contrato-de-upload

**Covers AC:** #1, #5
**Source:** auto
**Last sync:** 2026-10-10T17:08:30Z

**Steps:**
  1. POST /videos com `Authorization: Bearer <access_token>` e body `{ "filename": "aula.mp4", "size": 1048576, "mime_type": "video/mp4" }`
    - expect: status `201`
    - expect: body `processing_status` é `"uploading"` e `title` é `"aula"`
    - expect: body `upload.part_size` é `67108864` e `upload.part_count` é `1`
    - expect: body `public_id` tem 11 caracteres no alfabeto base64url (`/^[A-Za-z0-9_-]{11}$/`)
  2. Consultar a tabela `videos` pelo `public_id` retornado
    - expect: existe exatamente uma linha, com `channel_id` igual ao canal do usuário autenticado
    - expect: `published_at` é `NULL` e `upload_id` está preenchido
    - expect: `title` é `aula`, `declared_size` é `1048576` e `mime_type` é `video/mp4`

### 2. Rejeitar declarações fora da política de upload

**Setup:** igual ao grupo 1.

#### 2.1. rejeita-tamanho-acima-de-10-gib

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-10-10T17:08:30Z

**Steps:**
  1. POST /videos autenticado com `{ "filename": "big.mp4", "size": 10737418241, "mime_type": "video/mp4" }`
    - expect: status `400`
    - expect: body `error` é `"VALIDATION_ERROR"` (envelope `{ statusCode, error, message }`)
    - expect: nenhuma linha nova em `videos`

#### 2.2. rejeita-mime-fora-da-allowlist

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-10T17:08:30Z

**Steps:**
  1. POST /videos autenticado com `{ "filename": "foto.png", "size": 1024, "mime_type": "image/png" }`
    - expect: status `400`
    - expect: body `error` é `"VALIDATION_ERROR"`
    - expect: nenhuma linha nova em `videos`

### 3. Exigir autenticação

**Setup:** igual ao grupo 1.

#### 3.1. sem-token-retorna-401

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-10T17:08:30Z

**Steps:**
  1. POST /videos sem header `Authorization`, com body válido
    - expect: status `401`
    - expect: nenhuma linha nova em `videos`

### 4. Não aplicar o rate limit de auth

**Setup:** igual ao grupo 1, com o storage do throttler resetado antes do cenário.

#### 4.1. onze-chamadas-por-minuto-nao-recebem-429

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-10-10T17:08:30Z

**Steps:**
  1. POST /videos autenticado com body válido, 11 vezes seguidas dentro de 60 segundos
    - expect: todas as 11 respostas têm status `201`
    - expect: nenhuma resposta tem status `429`
