# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 5/15 completed

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
- **Status:** completed
- **Tests:** 17 passing (2 unit de módulo, 8 unit de chaves, 7 integração contra MinIO real)
- **Observations:**
  - Dois clientes S3 (interno e assinador público), ambos com `forcePathStyle` e checksums `WHEN_REQUIRED`. O teste de módulo confere que o host de cada um bate com `S3_ENDPOINT`/`S3_PUBLIC_ENDPOINT`.
  - **Integração:** `S3_PUBLIC_ENDPOINT` aponta para `localhost:9000`, inalcançável de dentro do container. Por isso o spec monta dois serviços: um com o endpoint público real (só confere a forma das URLs: origem, `X-Amz-Expires` 3600 e 900) e outro com o público sobrescrito para o interno (faz os PUT/GET de verdade).
  - `src/test/s3.ts` usa um bucket de teste separado (`<S3_BUCKET>-test`), criado sob demanda com a mesma policy de `thumbnails/`, e o esvazia (objetos + multiparts pendentes) a cada teste.
  - `putObjectFromFile` usa `PutObject` com stream e `ContentLength`: limite de 5 GB por objeto. O `playback.mp4` normalmente é bem menor que o original, mas uma normalização de um upload perto de 10 GB poderia estourar. Se virar problema, o caminho é multipart no worker; fica registrado como risco, sem ação neste SI.
  - O teste de `storage-keys.spec.ts` foi escrito junto com o código, sem etapa vermelha separada (função pura trivial).
  - Erro tipado `InvalidUploadPartsError` mapeia `InvalidPart`, `InvalidPartOrder`, `EntityTooSmall` e `NoSuchUpload`. Só `InvalidPart` foi exercitado contra o MinIO (ETag adulterado).

### SI-03.4 — Módulo de Fila e Entrypoint do Video Worker
- **Status:** completed
- **Tests:** 4 novos passing (1 unit, 3 integração com Redis/Postgres reais). Suíte `src` sem o spec de migrations: 29 suites, 175 testes. E2E: 3 suites, 52 testes.
- **Observations:**
  - **`ioredis` instalado:** o BullMQ 6 não traz o cliente Redis (peer opcional) e não conecta sem ele. É requisito técnico da TD-02, mas não consta no campo `Libraries` nem no `library-refs.md`. Sugestão: revisão na TD-02 e atualização do `library-refs.md`.
  - **Jest e `@nestjs/bullmq` 12 (ESM-only):** o Jest em CommonJS não carregava `@nestjs/bullmq` nem `@nestjs/bull-shared` (`SyntaxError: Unexpected token 'export'`). Mantive as versões fixadas e configurei o `transform` do Jest para transpilar só esses dois pacotes, em `package.json` e em `test/jest-e2e.json`. Rebaixar para a linha 11 (CJS) seria a alternativa.
  - **Nomes de teste:** `QueueModule` e `WorkerModule` abrem conexão (Redis/Postgres), então usei `*.integration-spec.ts`, como manda o `CLAUDE.md` do subprojeto, em vez de `*.module.spec.ts` do plano.
  - **`QUEUE_PREFIX` antecipado:** adicionei o prefixo do BullMQ (`queueConfig.prefix`, chave opcional no Joi, default `bull`) já neste SI, porque sem ele qualquer teste que enfileire jobs na fila padrão seria consumido pelo worker que roda no container. A ação 1 do SI-03.14 fica atendida.
  - **Worker em dev sem watch:** `start:worker:dev` usa `ts-node` (reinício manual do container). Dois `nest start --watch` no mesmo bind mount disputariam a pasta `dist/` (`deleteOutDir`). Em produção: `npm run build` + `npm run start:worker` (verificado: `dist/worker.js` sobe e loga o início).
  - **`QueueModule` agora faz parte do `AppModule`:** a API passa a depender do Redis no boot, o que o Compose já garante (`redis` healthy).
  - **PENDÊNCIA anterior a este SI (precisa de correção antes do DoD):** `src/database/migrations.integration-spec.ts` não é idempotente. Passa na primeira execução com banco limpo e falha em qualquer reexecução (`type "verification_tokens_type_enum" already exists`), porque derruba as tabelas mas não o tipo enum. Quando o `beforeAll` falha, o `afterAll` quebra e o `DataSource` nunca é destruído, e por isso o Jest fica pendurado. Reproduzido duas vezes seguidas, sem relação com este SI.
  - **PENDÊNCIA de lint (anterior):** 2 erros em `env.validation.integration-spec.ts` (já registrados no SI-03.1).

### SI-03.5 — Entidade Video, Migration CreateVideos e Gerador de public_id
- **Status:** completed
- **Tests:** 11 novos passing (8 do módulo `videos`: 5 de integração da entidade + 2 do `public-id` + 1 de módulo; 3 do spec de migrations, que cobre as 3 migrations). Suíte `src` completa: 33 suites, 186 testes. E2E: 3 suites, 52 testes. `tsc` com 0.
- **Observations:**
  - **Migration gerada pela CLI** (`migration:generate`, como exige `.claude/rules/typeorm-migrations.md`): `1791667207602-CreateVideos.ts`, com o diff contendo só `videos` (enum `video_processing_status`, FK para `channels`, índices `(channel_id)`, `(processing_status, created_at)` e a unicidade de `public_id`). Formatada pelo ESLint/Prettier do projeto.
  - **Teste de entidade contra o esquema real:** usa `synchronize: false`, ou seja, valida a tabela criada pela migration. Os specs de entidade existentes usam `synchronize: true` no banco compartilhado, o que criaria `videos` antes da migration e a faria falhar.
  - **Defeito antigo do spec de migrations corrigido** (era pendência do SI-03.4): ele derrubava as tabelas mas deixava os tipos enum, e fazia os `DROP TABLE ... CASCADE` em paralelo. Agora derruba as tabelas em sequência (filhas primeiro), remove os enums e foi repetido 4 vezes seguidas sem falha. Isso eliminou também o travamento do Jest na falha do `beforeAll`.
  - `cleanAllTables` agora apaga `videos` primeiro (a FK com `channels` quebraria os specs que limpam canais).
  - **Ação 4 do plano adiada:** registrar `Video` no `WorkerModule` não tem efeito até existir um consumidor do repositório; será feito no SI-03.10, quando o processor precisar do `Repository<Video>`.
  - `Channel` não ganhou lado inverso da relação, como definido no Data Model do plano.
  - **PENDÊNCIA DE LINT (anterior e fora do escopo):** `eslint` no projeto inteiro dá 190 problemas (150 erros, 40 avisos) em 11 arquivos já existentes (ex.: `auth.service.spec.ts`, `auth.service.integration-spec.ts`, `create-test-data-source.ts`, `env.validation.integration-spec.ts`). O número é idêntico antes e depois deste SI, e os arquivos novos estão limpos. Como a DoD exige `npm run lint` passando, isso precisa de uma decisão antes do fechamento.

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
