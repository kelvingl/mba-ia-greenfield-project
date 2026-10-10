# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 9/15 completed

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
- **Status:** completed
- **Tests:** 26 novos passing: 14 unit do serviço + 3 do utilitário de erros do Postgres, 3 de integração (Postgres + MinIO) e 5 e2e (spec `videos-create.plan.md`, 5 cenários, ACs #1–#6). Suíte `src`: 36 suites, 206 testes. E2E: 4 suites, 57 testes. `tsc` com 0.
- **Observations:**
  - **Sem transação no `createDraft`:** o plano dizia "numa transação", mas um `INSERT` que viola a unicidade aborta a transação inteira no Postgres, e isso impediria o retry do `public_id`. Uso inserção com retry (até 5 tentativas) + abertura do multipart + compensação (apaga a linha se o storage falhar), padrão descrito em `.claude/rules/nestjs-testing.md`. O risco residual (multipart aberto sem linha, se o `save` final falhar) é limpo pelo expiry de 24 h do MinIO.
  - **Exceções de domínio em `common/exceptions/domain.exception.ts`**, não em `videos.exceptions.ts`: é onde todas as do projeto vivem. Criei as 6 do catálogo + `ChannelNotFoundException` (`CHANNEL_NOT_FOUND`, 404), que o plano não lista: defensiva, praticamente inalcançável, porque todo usuário nasce com canal.
  - **`ChannelsService.findByUserId`** adicionado, para não ler `Channel` direto do módulo de vídeos (separação de domínios).
  - O título derivado do arquivo cai para `Untitled video` quando o nome é vazio (ex.: `.mp4`). A extensão do objeto vem do MIME (`.mp4`, `.mov`, `.webm`, `.mkv`), nunca do nome enviado.
  - **OpenAPI já anotado no controller** (`ApiTags`, `ApiOperation`, `ApiResponse`, `ApiBearerAuth`): a regra de controller do projeto exige a documentação na mesma mudança. O SI-03.13 faz o restante (DTOs de resposta das outras rotas, export e sincronização).
  - **`test:e2e` agora roda com `--runInBand`** no `package.json`. Os e2e compartilham o banco e o `CLAUDE.md` do subprojeto já exigia a flag, mas o script não a tinha; com 4 suites em paralelo apareceram falhas por corrida.
  - **`test/helpers/e2e-app.ts`** (app com a config global do `main.ts` + usuário autenticado confirmado direto no banco) será reutilizado pelos e2e dos SIs 03.7, 03.8, 03.12 e 03.14.
  - `utilitário isUniqueViolationOnColumn` criado em `common/database/pg-errors.ts`; o `ChannelsService` tem uma cópia privada equivalente, que deixei como está (fora do escopo).

### SI-03.7 — Endpoints do Plano de Controle do Upload: URLs de Parte, Partes Enviadas e Conclusão
- **Status:** completed
- **Tests:** 24 novos passing: 11 unit do serviço, 3 de integração (Postgres + MinIO) e 7 e2e (spec `videos-upload.plan.md`, 7 cenários, ACs #1–#7). Suíte `src`: 36 suites, 223 testes. E2E: 5 suites, 64 testes. `tsc` com 0 e os arquivos novos sem lint.
- **Observations:**
  - **Rotas** `POST /videos/:publicId/upload/part-urls` (200), `GET /videos/:publicId/upload/parts` (200) e `POST /videos/:publicId/upload/complete` (202), todas documentadas com OpenAPI. `complete` só finaliza o multipart no storage: não enfileira nem verifica tamanho, e o teste e2e confere que a fila fica vazia.
  - **Não-dono e inexistente são indistinguíveis:** a busca filtra por `channel.user_id` do chamador e ambos respondem `404 VIDEO_NOT_FOUND`.
  - O e2e envia a peça de **64 MiB** do spec de verdade ao MinIO (~0,7 s por teste) e confere o tamanho final do objeto (`64 MiB + 1 KiB`).
  - `StorageService.partUrlTtlSeconds` foi exposto para a resposta carregar `expires_in` sem o serviço de vídeos ler a config de storage.
  - **Armadilha do supertest registrada no teste:** criar várias requisições antes de aguardá-las faz a primeira fechar o servidor efêmero compartilhado (`ECONNREFUSED`); os testes de acesso as constroem sob demanda.
  - **Limitação conhecida:** repetir `complete` depois de um upload já finalizado retorna `400 INVALID_UPLOAD_PARTS` (o storage responde `NoSuchUpload`, que mapeei junto com os demais erros de partes). Como o gatilho do processamento é o evento do storage (TD-06 B), uma segunda chamada não causa dano, mas a resposta não é idempotente. Se for desejável, vale decidir isso no SI-03.8 ou numa revisão da TD.
  - Só `InvalidPart` foi exercitado contra o MinIO real; os outros nomes de erro mapeados (`InvalidPartOrder`, `EntityTooSmall`, `NoSuchUpload`) estão cobertos só no nível unitário.

### SI-03.8 — Webhook de Eventos do Storage, Verificação de Tamanho e Enfileiramento
- **Status:** completed
- **Tests:** 25 unit/integração (parser, guard, `StorageEventsService`) + 5 e2e (`test/internal-storage-events.e2e-spec.ts`); suíte `src` e e2e completas verdes (69 e2e), `tsc` exit 0
- **Observations:**
  - O corpo do webhook é tipado `unknown` e validado à mão em `parseObjectCreatedRecords`: um DTO seria rejeitado pelo `forbidNonWhitelisted` global, já que a notificação S3 traz muitos campos que não são nossos.
  - O token é comparado em tempo constante (SHA-256 dos dois lados + `timingSafeEqual`), o que dispensa tratar tamanhos diferentes.
  - Verificado empiricamente contra o MinIO real: ele monta o header `Authorization` sozinho a partir de `AUTH_TOKEN` (chega `Bearer <token>`), então o compose passa só o token cru, sem prefixo.
  - A chave no evento do MinIO vem como `bucket/originals/...` no campo de topo; o consumidor usa `Records[].s3.object.key` (sem bucket, URL-encoded).
  - `compose.yaml`: `MINIO_NOTIFY_WEBHOOK_*_PRIMARY` com `QUEUE_DIR` em `/data/.events` (eventos sobrevivem a uma queda da API). `minio-init.mjs` registra a notificação (`CompleteMultipartUpload`, prefixo `originals/`) via `PutBucketNotificationConfiguration`.
  - Evento para vídeo já em `processing` reenfileira (o `jobId = videoId` torna isso no-op se o job existe), cobrindo a janela entre o UPDATE e o `queue.add`.
  - `VideosModule` agora importa `QueueModule`; `videos.module.spec.ts` e `videos.service.integration-spec.ts` ganharam `queueConfig` no `ConfigModule`.
  - A decisão sobre a não idempotência de `complete` (SI-03.7) segue em aberto: não foi alterada aqui.

### SI-03.9 — FfmpegService: Probe, Thumbnail e Normalização para Playback
- **Status:** completed
- **Tests:** 15 passing (6 unit de `needsTranscode`, 9 integração com FFmpeg real + MinIO); `tsc` exit 0; arquivos novos sem erros de lint
- **Observations:**
  - `probe` classifica como `PermanentMediaError` só o que é mídia ilegível (`Invalid data found`, `moov atom not found`, `could not find codec parameters`) ou ausência de stream de vídeo. Qualquer outro erro do ffprobe (arquivo/URL inacessível) sobe como `Error` comum, para o processor poder tentar de novo. Isso é um heurístico sobre a mensagem do ffprobe, coberto por testes de bytes aleatórios e de caminho inexistente.
  - O thumbnail usa offset de 10% da duração, limitado a `duração - 1 s` para vídeos curtos (o TD-13 diz "~10%, clamped"); a saída é forçada com `.format('image2')` porque a extensão `.jpg` sozinha já basta, mas assim não depende dela.
  - O thumbnail é sempre escalado para 1280 px de largura, inclusive quando a origem é menor (fixture de 640x360 vira 1280x720), como o critério de aceite pede.
  - `normalizeForPlayback` faz remux (`-c copy`) quando `needsTranscode` é falso e, senão, `libx264 -pix_fmt yuv420p` + `aac`; ambos com `+faststart`, sempre em arquivo.
  - Fixtures geradas sob demanda por `src/test/media.ts` (lavfi); inclui `topLevelBoxes` (ordem `moov`/`mdat`) e `jpegSize`, que evitam depender de `ffprobe` para verificar a própria saída.
  - O probe via URL presigned interna foi exercitado com um objeto real no MinIO.

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
