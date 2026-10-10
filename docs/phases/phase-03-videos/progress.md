# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 1/15 completed

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
- **Status:** pending
- **Tests:** —
- **Observations:** none

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
