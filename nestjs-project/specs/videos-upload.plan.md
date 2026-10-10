---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.7
target_file: test/videos-upload.e2e-spec.ts
---

# Upload control plane (part URLs, parts, complete) — Test Plan

## Application Overview

O plano de controle do upload deixa o dono de um rascunho enviar até 10GB direto ao object storage:
- `POST /videos/:publicId/upload/part-urls` assina URLs `UploadPart` em lote (TTL de 1 h);
- `GET /videos/:publicId/upload/parts` lista as partes já armazenadas, para retomada;
- `POST /videos/:publicId/upload/complete` finaliza o multipart e responde `202`, sem enfileirar processamento. Quem promove o vídeo a `processing` é o evento do storage.

As três rotas são só do dono: quem não é dono recebe `404 VIDEO_NOT_FOUND`, e um vídeo que não está mais `uploading` responde `409 INVALID_UPLOAD_STATE`.

## Test Scenarios

### 1. Assinar URLs de parte

**Setup:**
- antes do bootstrap, `process.env.S3_PUBLIC_ENDPOINT = 'http://minio:9000'`, para as URLs presigned serem alcançáveis de dentro do container;
- antes do bootstrap, `process.env.QUEUE_PREFIX` recebe um valor único do arquivo, para isolar as filas do worker do container;
- sobe o `AppModule` reproduzindo a config global de `main.ts`;
- `beforeEach`: `cleanAllTables(dataSource)` + `emptyTestBucket()`;
- o dono é registrado, confirmado e logado.

O rascunho é criado via `POST /videos`.

#### 1.1. assina-partes-em-lote-com-ttl-de-1h

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-10-10T17:08:30Z

**Steps:**
  1. POST /videos como dono, com `{ "filename": "longo.mp4", "size": 70000000, "mime_type": "video/mp4" }`
    - expect: status `201` com `upload.part_count` igual a `2`
  2. POST /videos/:publicId/upload/part-urls com `{ "part_numbers": [1, 2] }`
    - expect: status `200`
    - expect: `urls` tem 2 itens, com `part_number` `1` e `2`
    - expect: a origem de cada `url` é igual à de `S3_PUBLIC_ENDPOINT`, e o parâmetro `X-Amz-Expires` é `3600`
    - expect: `expires_in` é `3600`

#### 1.2. rejeita-numero-de-parte-fora-da-faixa

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-10-10T17:08:30Z

**Steps:**
  1. POST /videos como dono, com `size` de 1 MiB (`part_count` = `1`)
  2. POST /videos/:publicId/upload/part-urls com `{ "part_numbers": [2] }`
    - expect: status `400`
    - expect: body `error` é `"INVALID_PART_NUMBER"`

### 2. Retomar e concluir o upload

**Setup:** igual ao grupo 1. O rascunho é criado com `size` = 67108864 + 1024 (`part_count` = `2`). A parte 1 tem 64 MiB e a parte 2 tem 1 KiB; ambas são enviadas por `PUT` nas URLs assinadas, e os `ETag` de resposta são guardados.

#### 2.1. lista-partes-enviadas-para-retomada

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-10T17:08:30Z

**Steps:**
  1. Fazer PUT das partes 1 e 2 nas URLs retornadas por `part-urls`
    - expect: cada PUT responde `200` com header `ETag`
  2. GET /videos/:publicId/upload/parts como dono
    - expect: status `200`
    - expect: `parts` tem 2 itens, com `part_number` `1` e `2` e `etag` iguais aos retornados nos PUTs
    - expect: `part_size` é `67108864` e `part_count` é `2`

#### 2.2. conclui-multipart-com-etags-corretos

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-10T17:08:30Z

**Steps:**
  1. POST /videos/:publicId/upload/complete com `{ "parts": [{ "part_number": 1, "etag": "<etag1>" }, { "part_number": 2, "etag": "<etag2>" }] }`
    - expect: status `202`
    - expect: body `processing_status` é `"uploading"`
  2. `HeadObject` em `originals/{videoId}/source.mp4` no bucket de teste
    - expect: o objeto existe com `ContentLength` igual a 67109888
  3. Consultar a fila `video-processing` (prefixo do teste)
    - expect: nenhum job foi enfileirado pelo `complete`

#### 2.3. rejeita-conclusao-com-etag-adulterado

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-10T17:08:30Z

**Steps:**
  1. POST /videos/:publicId/upload/complete com o `etag` da parte 1 trocado por `"\"0000\""`
    - expect: status `400`
    - expect: body `error` é `"INVALID_UPLOAD_PARTS"`
    - expect: o vídeo continua `uploading`

### 3. Proteger o upload de quem não é dono e de estados inválidos

**Setup:** igual ao grupo 1, com um segundo usuário (não-dono) registrado, confirmado e logado.

#### 3.1. nao-dono-recebe-404-em-todas-as-rotas

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-10-10T17:08:30Z

**Steps:**
  1. O dono cria um rascunho via POST /videos
  2. O não-dono chama `POST .../upload/part-urls`, `GET .../upload/parts` e `POST .../upload/complete` no `publicId` do dono
    - expect: as três respostas têm status `404` com `error` `"VIDEO_NOT_FOUND"`
  3. O não-dono chama `GET /videos/AAAAAAAAAAA/upload/parts` (inexistente)
    - expect: status `404` com o mesmo corpo do passo 2 (não revela existência)

#### 3.2. video-fora-de-uploading-retorna-409

**Covers AC:** #7
**Source:** auto
**Last sync:** 2026-10-10T17:08:30Z

**Steps:**
  1. O dono cria um rascunho; no banco, o vídeo é movido para `processing_status = 'processing'`
  2. O dono chama `POST .../upload/part-urls`, `GET .../upload/parts` e `POST .../upload/complete`
    - expect: as três respostas têm status `409` com `error` `"INVALID_UPLOAD_STATE"`
