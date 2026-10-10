# Plano — `/research` Fase 03 (Upload e Processamento de Vídeos), fatia backend

## Contexto

O usuário rodou `/research fase 3`. A skill gera um documento de decisões técnicas (TDs) com opções, trade-offs e recomendação; o usuário decide depois e o pipeline segue `/plan-context → /plan-validate → /plan-resolve`.

Escolhas do usuário nesta sessão:
- **Fase 03 é só backend** (conforme `enunciado.md`: "a interface de vídeo não faz parte do escopo desta fase"). Não há fatia de frontend nesta fase; as TDs cross-layer fixam o contrato da API, e o lado FE é descrito apenas como hand-off para as Fases 04/05.

O que a investigação encontrou e que molda as TDs:
- **BFF estrito** (`next-frontend-config-base/TD-03`): o browser nunca chama o NestJS. Mandar 10 GB por Route Handler do Next → Nest não é viável. O diagrama C4 já mostra `Frontend → Object Storage` direto, então upload e streaming direto browser↔storage não violam o BFF.
- **Status do MinIO:** a edição community parou de publicar imagens Docker (out/2025), entrou em modo manutenção (dez/2025) e teve o repositório arquivado (2026). Hoje só existe código-fonte. Isso afeta a TD de storage.
- **O guia de testes conflita:** `.claude/skills/testing-guide-nestjs-project/references/external-systems.md` define "Object Storage — Local Filesystem em dev/test, S3 em prod". Filesystem local não suporta presigned multipart, então o guia precisa ser revisto se a TD-04 ficar com a opção A.
- **`fluent-ffmpeg` está deprecated** no npm (última versão 2.1.3, maio/2024).
- **O Uppy 6 reescreveu o `@uppy/aws-s3`:** os seis callbacks viraram um único `signRequest`, e o cliente faz as chamadas S3 sozinho. Isso pode conflitar com um Complete mediado pelo servidor. Fica registrado como dependência para a fatia FE.
- **Rede:** os containers acessam o storage pelo nome de serviço Compose, mas o browser precisa de uma URL alcançável pelo host. Por isso as URLs presigned precisam ser assinadas com um endpoint público. Isso vira um contrato de env (Joi + compose + `.env.example`).
- **Versões:** o backend usa Node 25.6 (`require(esm)` funciona, então pacotes só-ESM são aceitáveis) e ainda não tem libs de fila, storage ou ffmpeg. Já existe `testing-guide` com um esboço de BullMQ.

## Saída

Arquivo: `docs/decisions/technical-decisions-phase-03-videos.md` (nome exigido pelo `enunciado.md`). Não há colisão de slug.

Frontmatter: `scope_type: phase`, `related_phases: [3]`, `status: pending`, `date: 2026-10-09`, sem `covers_capabilities` (mesmo padrão do `phase-02-auth.md`). Segue a estrutura de `technical-decisions-phase-02-auth-frontend.md`:
- bloco "Subprojects in scope";
- âncoras cross-doc para o que já está decidido;
- cada TD com Scope, Capability, Context, 2 a 4 Options, Recommendation e `Decision: _[pending]_`;
- tabela de resumo, notas para o pipeline e fontes.

Subprojetos:
- `nestjs-project/`: principal. Recebe VideosModule, storage, fila, worker, compose (redis, storage, worker).
- `next-frontend/`: **nenhuma TD e nenhum trabalho na Fase 03** (fora do escopo pelo enunciado). As TDs cross-layer descrevem o impacto no FE só como hand-off para as Fases 04/05.

## TDs (opções → recomendação)

| # | Scope | TD | Opções | Recomendação |
|---|---|---|---|---|
| 01 | Backend | Servidor de object storage (dev/test) + SDK | A MinIO com imagem fixada (última oficial ou Chainguard) · B SeaweedFS · C Garage · D FS local por trás de abstração (guia atual) | **A**, como emulador só de dev, já que prod é S3. O código fica preso apenas à API S3 via `@aws-sdk/client-s3`, então trocar o servidor é só mudar o compose. D é incompatível com presigned multipart. Registrar o risco de "MinIO sem manutenção" e SeaweedFS como plano B. Exige revisar o guia de testes. |
| 02 | Backend | Tecnologia de fila | A BullMQ + Redis (`@nestjs/bullmq`) · B pg-boss (Postgres, sem nova infra) · C RabbitMQ | **A**: módulo first-party do Nest, retries/backoff/progress/concurrency prontos, alinhado ao esboço do guia de testes. B é a alternativa honesta sem infra nova. |
| 03 | Backend | Topologia do worker | A container separado com o mesmo código (entrypoint `worker.ts` via `createApplicationContext`, imagem com ffmpeg) · B processor in-process no container da API · C subprojeto `video-worker/` separado | **A**: bate com o C4 (container "Video Worker") e isola a CPU do FFmpeg da API ("sem impacto na performance"), reaproveitando entidades e config. |
| 04 | Cross-layer | Protocolo de upload (≤10 GB, retomável) | A S3 multipart com partes presigned, browser→storage direto; Create/ListParts/Complete/Abort mediados pela API via BFF · B tus (`@tus/server` + `@tus/s3-store`) · C upload em chunks proxiado BFF→API→storage | **A**: os bytes não passam por Next nem por Nest, a retomada vem de ListParts, e o BFF continua estrito para o plano de controle. B exige expor um endpoint tus público (quebra o BFF) ou proxiar 10 GB. C viola a performance. Registrar a dependência do Uppy 6 `signRequest` para a fatia FE. |
| 05 | Cross-layer | Modelagem do ciclo de vida do vídeo | A enum única com tudo (uploading/processing/ready/failed/draft/published) · B dois eixos: `processing_status` (uploading→processing→ready\|failed) + estado de publicação (draft por padrão; a publicação é da Fase 04) · C só flags booleanas | **B**: rascunho/publicação (Fase 04) é ortogonal ao pipeline, o que evita um enum combinatório. Visibilidade entra na Fase 04 como outra coluna. |
| 06 | Backend | Sinal de conclusão do upload → job | A cliente chama `complete`; a API executa CompleteMultipartUpload + HeadObject e enfileira · B notificação de bucket (webhook/fila do storage) · C A + varredura de reconciliação | **A**: portável entre servidores S3. B é específico de cada servidor e não roda igual em dev e prod. |
| 07 | Cross-layer | Política de validação e limites do upload | A declara-e-verifica: init com tamanho/mime, a API recusa >10 GB ou mime fora da allowlist, o **servidor define o tamanho da parte** (ex.: 64 MiB, limite de 10 000 partes), HeadObject após complete, ffprobe no worker como autoridade final, lifecycle `AbortIncompleteMultipartUpload` + varredura de rascunhos `uploading` antigos · B só checagem no cliente + worker · C inspeção de conteúdo antes de aceitar | **A**: o tamanho da parte e os limites são contrato BE↔FE. A validação real fica no ffprobe, e a limpeza fica no storage. |
| 08 | Backend | Integração com FFmpeg | A ffmpeg/ffprobe do sistema na imagem do worker + `child_process.spawn` com wrapper tipado · B `fluent-ffmpeg` · C binários `ffmpeg-static`/`ffprobe-static` | **A**: B está deprecated. C fixa binários por plataforma e incha o `node_modules`, e o container já controla a versão. |
| 09 | Backend | Acesso do worker ao arquivo de origem | A ffprobe/ffmpeg lendo direto da URL presigned (HTTP Range) · B baixar o objeto inteiro para volume temporário · C híbrido (probe e thumbnail via URL, download só quando a TD-10 exigir) | **C**: probe e thumbnail leem só alguns MB. O download (ou a entrada em streaming) só acontece quando há remux/transcode. Depende da TD-10. |
| 10 | Cross-layer | Formato de entrega para streaming | A original como está + allowlist de formatos (MP4/WebM) · B normalizar para MP4 H.264/AAC `+faststart` (remux se compatível, transcode só se não) · C HLS adaptativo (múltiplas renditions + hls.js no player da Fase 05) | **B**: tocável em qualquer browser via Range, barato no caso comum (remux), sem lib de player extra. C fica adiado por custo de CPU e storage. |
| 11 | Cross-layer | Caminho de entrega de mídia + assinatura de URL (streaming + download) | A tudo privado com GET presigned · B bucket público com chaves não adivinháveis · C proxy com Range pela API/BFF · D híbrido: vídeos privados com presigned de TTL curto (download com `ResponseContentDisposition=attachment`) e thumbnails num prefixo public-read | **D**: rascunhos e unlisted (Fases 04/05) nunca ficam expostos por URL fixa, e thumbnails ficam cacheáveis nos grids. Inclui o contrato de endpoint público para assinatura (`S3_ENDPOINT` interno vs `S3_PUBLIC_ENDPOINT`) e `next/image` `remotePatterns` para a fatia FE. |
| 12 | Cross-layer | ID público único na URL | A ID aleatório base64url de 11 caracteres (`node:crypto`, ~66 bits) em coluna `public_id` UNIQUE com retry · B UUID da PK na URL · C Sqids sobre sequência bigint | **A**: curto, não enumerável e sem dependência nova. A PK uuid continua interna. C é reversível e enumerável. |
| 13 | Backend | Política de geração de thumbnail | A frame em offset fixo (~10% da duração, `-ss` antes de `-i`) · B seek + filtro `thumbnail` numa janela curta · C vários candidatos (25/50/75%) | **B**: evita frames pretos ou de fade com custo limitado. Saída em JPEG, largura 1280 (formato e tamanho entram como contrato com `next/image`). |
| 14 | Cross-layer | Propagação do status de processamento ao FE | A polling via BFF enquanto `uploading/processing` · B SSE do Nest repassado pelo Route Handler · C WebSocket | **A**: encaixa no BFF estrito e no padrão de teste com MSW. Processamento leva minutos, então a latência do polling é irrelevante. |
| 15 | Backend | Política de falha no processamento | A 3 tentativas + backoff, `UnrecoverableError` para erros permanentes, `failed` + `failure_reason` · B falha no primeiro erro · C A + endpoint de reprocessamento | **A**: estados terminais sempre alcançados, tolera falhas transitórias sem gastar retries em entradas inválidas. C é extrapolação. (Adicionada em 2026-10-10 para atender o enunciado: "o que acontece em caso de falha no processamento".) |

Itens descartados por não serem estratégicos (o teste (d)+(a) da skill): nomes de fila/scripts, layout de chaves dentro do bucket, título padrão do rascunho (nome do arquivo), checagem de dono nos endpoints de upload (guards existentes), fixtures de vídeo para teste, healthchecks do compose. A estratégia de teste de storage não vira TD própria: é consequência da TD-01 e fica nas Notes como atualização do guia de testes.

**Notes for downstream pipeline** vai conter:
- Dependências entre TDs: 04→06/07, 10→09, 01→11.
- Hand-off de FE para as Fases 04/05: lib cliente (Uppy 6 vs custom), retomada após reload, UI de progresso, E2E browser→storage.
- A revisão do `external-systems.md`.
- Chaves de env novas (S3_*, REDIS_*), validadas pelo Joi da Fase 01.
- Rede entre stacks Compose separadas (o browser alcança o storage pela porta publicada no host).

Fontes: docs do BullMQ, docs do Uppy (aws-s3 e guia de migração), presigner do AWS SDK v3, posts sobre o status do MinIO (linuxiac, glukhov, chainguard), página npm do fluent-ffmpeg, blog do tus-node-server v2, comparativo pkgpulse de pg-boss vs BullMQ.

## Execução (após aprovação)

1. Escrever `docs/decisions/technical-decisions-phase-03-videos.md` com o formato completo acima. Cada opção com no máximo ~6 linhas, recomendações justificadas pelo contexto do projeto e todos os `Decision: _[pending]_`.
2. Nenhum código nem outro arquivo é alterado.

## Verificação

- Toda TD tem `**Scope:**` e uma `**Capability:**` literal da Fase 03 (ou `Transversal — covers: ...`). Checar com grep `^## TD-` e `^\*\*Capability`.
- Os 9 bullets da Fase 03 aparecem em pelo menos uma TD (checagem informal; o gate formal é do `plan-validate`).
- Nenhuma TD reabre decisões anteriores (BFF estrito, erro em envelope, Joi/config, guards JWT).
- Próximo passo: `/plan-context 3` → `/plan-validate` ↔ `/plan-resolve` → `/plan-build`, gerando os artefatos em `docs/phases/phase-03-videos/`.

## Ajustes de 2026-10-10 (alinhamento com `enunciado.md`)

- Renomeados para os nomes exigidos: `docs/decisions/technical-decisions-phase-03-videos.md` e `docs/phases/phase-03-videos/`.
- FE fora do escopo da Fase 03.
- TD-06 = B e TD-08 = B mantidas, com justificativa e mitigação registradas em blocos **Revisions**.
- Revisions em TD-05 (mapeamento do ciclo rascunho → processando → pronto/erro), TD-07 (valores concretos, título, checagem de tamanho no consumidor de eventos), TD-10 (original mantido) e TD-11 (acesso só do dono na Fase 03, Range/206).
- Nova TD-15 (política de falha), decidida A.
