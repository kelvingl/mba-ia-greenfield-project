---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.12
target_file: test/videos-delivery.e2e-spec.ts
---

# Video status, playback and download — Test Plan

## Application Overview

Três rotas só do dono expõem o estado e a entrega de um vídeo:
- `GET /videos/:publicId` devolve o status de processamento, para polling. Inclui `failure_reason`, metadados e `thumbnail_url` (pública, só quando `ready`).
- `GET /videos/:publicId/playback-url` emite uma URL presigned de curta duração para `playback.mp4`. O streaming acontece por requisições `Range`, respondidas com `206 Partial Content`.
- `GET /videos/:publicId/download-url` emite uma URL presigned do arquivo original, com `Content-Disposition: attachment`.

Playback e download exigem `ready`; fora desse estado respondem `409 VIDEO_NOT_READY`. Quem não é dono recebe `404 VIDEO_NOT_FOUND`.

## Test Scenarios

### 1. Consultar o status do vídeo

**Setup:**
- antes do bootstrap, `process.env.S3_PUBLIC_ENDPOINT = 'http://minio:9000'`, para as URLs serem alcançáveis de dentro do container;
- sobe o `AppModule` reproduzindo a config global de `main.ts`;
- `beforeEach`: `cleanAllTables(dataSource)` + `emptyTestBucket()`;
- o dono é registrado, confirmado e logado, e um rascunho é criado via `POST /videos`.

Os vídeos `ready` são semeados direto no banco (`processing_status = 'ready'`, metadados e chaves preenchidos). Os objetos correspondentes são gravados no bucket de teste:
- `originals/{id}/source.mp4`: 4096 bytes conhecidos;
- `playback/{id}.mp4`: 4096 bytes;
- `thumbnails/{id}.jpg`: um JPEG pequeno.

#### 1.1. status-de-video-ainda-nao-pronto

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-10-10T17:08:30Z

**Steps:**
  1. GET /videos/:publicId como dono, sobre o rascunho recém-criado
    - expect: status `200`
    - expect: `processing_status` é `"uploading"`, `failure_reason` é `null`, `published_at` é `null` e `thumbnail_url` é `null`
    - expect: `public_id` e `title` correspondem ao rascunho

#### 1.2. status-de-video-pronto-com-thumbnail-publico

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-10-10T17:08:30Z

**Steps:**
  1. GET /videos/:publicId como dono, sobre o vídeo `ready` semeado
    - expect: status `200`
    - expect: `processing_status` é `"ready"` e `duration_seconds`, `width` e `height` estão preenchidos
    - expect: `thumbnail_url` é uma URL não assinada sob o prefixo `thumbnails/`
  2. GET em `thumbnail_url` sem nenhuma autenticação
    - expect: status `200` com `Content-Type` `image/jpeg`

### 2. Entregar mídia de um vídeo pronto

**Setup:** igual ao grupo 1, usando o vídeo `ready` semeado.

#### 2.1. playback-url-permite-streaming-por-range

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-10T17:08:30Z

**Steps:**
  1. GET /videos/:publicId/playback-url como dono
    - expect: status `200` com `url` (presigned, apontando para `playback/{id}.mp4`) e `expires_in` positivo
  2. GET em `url` com header `Range: bytes=0-1023`
    - expect: status `206 Partial Content`
    - expect: `Content-Length` é `1024` e `Content-Range` é `bytes 0-1023/4096`

#### 2.2. download-url-entrega-o-original-como-anexo

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-10T17:08:30Z

**Steps:**
  1. GET /videos/:publicId/download-url como dono
    - expect: status `200` com `url` contendo o parâmetro `response-content-disposition`
  2. GET em `url` sem `Range`
    - expect: status `200`
    - expect: header `Content-Disposition` começa com `attachment` e contém `filename="<title>.mp4"`
    - expect: o corpo é byte a byte igual aos 4096 bytes gravados em `originals/{id}/source.mp4`

### 3. Recusar entrega de vídeo não pronto e de quem não é dono

**Setup:** igual ao grupo 1, com um segundo usuário (não-dono) registrado, confirmado e logado.

#### 3.1. playback-e-download-antes-de-pronto-retornam-409

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-10T17:08:30Z

**Steps:**
  1. GET /videos/:publicId/playback-url como dono, sobre o rascunho `uploading`
    - expect: status `409` com `error` `"VIDEO_NOT_READY"`
  2. GET /videos/:publicId/download-url como dono, sobre um vídeo em `processing`
    - expect: status `409` com `error` `"VIDEO_NOT_READY"`

#### 3.2. nao-dono-recebe-404-indistinguivel-de-inexistente

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-10-10T17:08:30Z

**Steps:**
  1. O não-dono chama `GET /videos/:publicId`, `GET .../playback-url` e `GET .../download-url` sobre o vídeo `ready` do dono
    - expect: as três respostas têm status `404` com `error` `"VIDEO_NOT_FOUND"`
  2. O não-dono chama `GET /videos/AAAAAAAAAAA` (inexistente)
    - expect: status `404` com corpo idêntico ao do passo 1
