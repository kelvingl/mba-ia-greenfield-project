# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 2/15 completed

### SI-03.1 — Infra: Dependências, Namespaces de Configuração e Validação de Env
- **Status:** completed
- **Tests:** 19 passing (`src/config`: 12 novos em `env.validation.spec.ts` + 7 existentes)
- **Observations:**
  - `fluent-ffmpeg` ficou com pin exato `2.1.3` (o `npm install` gravou `^2.1.3`; corrigido em `package.json`, e o lockfile resolve `2.1.3`).
  - `.env` está no `.gitignore`: atualizado só localmente; o `.env.example` (versionado) tem as mesmas chaves.
  - `env.validation.integration-spec.ts` (existente) ganhou as chaves de storage/fila em `requiredEnv`, porque agora são obrigatórias. É consequência direta do SI.
  - `npx eslint` aponta 2 erros pré-existentes (`no-unsafe-assignment`/`no-unsafe-member-access`) em `env.validation.integration-spec.ts`. Já existem em `HEAD` e ficam fora do escopo deste SI; precisam ser resolvidos antes do `npm run lint` da verificação final.
  - Os 4 critérios de aceite foram conferidos: chaves ausentes falham no Joi nomeando a chave, `partUrlTtlSeconds = 3600`, pin exato e hosts internos sem `localhost`.

### SI-03.2 — Infra: Docker Compose com MinIO, Redis e FFmpeg na Imagem
- **Status:** completed
- **Tests:** no tests (Infra); critérios de aceite verificados contra a stack real
- **Observations:**
  - **Imagem do MinIO:** `minio/minio` e `minio/mc` não existem mais no Docker Hub, e o Quay exige login. Usei as imagens gratuitas do Chainguard **fixadas por digest** (`minio` e `minio-client`), alternativa já prevista na TD-01. O servidor resolvido é `RELEASE.2026-09-22`.
  - **`minio-init` não usa `mc`:** as imagens do Chainguard são distroless (sem `/bin/sh`), então não dá para encadear comandos `mc`. O init é `scripts/minio-init.mjs` (AWS SDK, já instalado), rodado numa instância da imagem do projeto. Cria o bucket e aplica a policy de leitura anônima só em `thumbnails/`; é idempotente (reexecução confirmada).
  - **CORS e lifecycle diferem do plano, por limitação do MinIO** (testado contra o servidor):
    - CORS por bucket retorna `NotImplemented`. Configurei CORS no servidor (`MINIO_API_CORS_ALLOW_ORIGIN=http://localhost:3001`). Verificado: origem aceita e `ETag` exposto, o que a TD-04 exige.
    - A regra de lifecycle `AbortIncompleteMultipartUpload` é rejeitada (`InvalidArgument`), então o critério "regra aparece no bucket" não é atingível no MinIO. O equivalente é `MINIO_API_STALE_UPLOADS_EXPIRY=24h` (limpeza a cada 6 h). Em S3 de produção a regra de lifecycle da TD-07 continua aplicável.
  - **Sem healthcheck no `minio`:** a imagem não tem shell nem `curl`. O `nestjs-api` espera o `minio-init` concluir com sucesso, que serve de prova de prontidão. `redis` tem healthcheck `redis-cli ping` e está `healthy`.
  - FFmpeg 5.1.9 instalado na imagem (`apt`), e `ffprobe -version` sai com 0.
  - Os serviços `video-worker` e a notificação de bucket (`notify_webhook`) ficam para o SI-03.4 e o SI-03.8, como no plano.

### SI-03.3 — Módulo de Storage sobre a API S3
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.4 — Módulo de Fila e Entrypoint do Video Worker
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.5 — Entidade Video, Migration CreateVideos e Gerador de public_id
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.6 — Endpoint POST /videos: Pré-cadastro do Rascunho e Início do Multipart
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.7 — Endpoints do Plano de Controle do Upload: URLs de Parte, Partes Enviadas e Conclusão
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.8 — Webhook de Eventos do Storage, Verificação de Tamanho e Enfileiramento
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.9 — FfmpegService: Probe, Thumbnail e Normalização para Playback
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.10 — VideoProcessor: Pipeline de Processamento e Política de Falha
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.11 — Varredura de Uploads Parados (Job Scheduler na Fila maintenance)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.12 — Endpoints de Status, Playback (Streaming) e Download
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.13 — Documentação OpenAPI dos Endpoints de Vídeo e Sincronização do Contrato
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.14 — Verificação Ponta a Ponta do Pipeline de Vídeo
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.15 — Atualizar CLAUDE.md com a Seção de Vídeos
- **Status:** pending
- **Tests:** —
- **Observations:** none
