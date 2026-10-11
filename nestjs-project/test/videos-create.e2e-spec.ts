import request from 'supertest';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { emptyTestBucket, useTestBucket } from '../src/test/s3';
import {
  createAuthenticatedUser,
  createE2eApp,
  E2eContext,
} from './helpers/e2e-app';

// Spec: specs/videos-create.plan.md (SI-03.6)
describe('videos-create', () => {
  let ctx: E2eContext;
  let accessToken: string;
  let channelId: string;

  const validBody = {
    filename: 'aula.mp4',
    size: 1048576,
    mime_type: 'video/mp4',
  };

  beforeAll(async () => {
    useTestBucket();
    ctx = await createE2eApp();
  });

  beforeEach(async () => {
    await cleanAllTables(ctx.dataSource);
    await emptyTestBucket();
    ctx.throttlerStorage.storage.clear();
    ({ accessToken, channelId } = await createAuthenticatedUser(
      ctx,
      'owner@example.com',
    ));
  });

  afterAll(async () => {
    await cleanAllTables(ctx.dataSource);
    await ctx.app.close();
  });

  const postVideo = (body: object, token: string | null = accessToken) => {
    const req = request(ctx.app.getHttpServer()).post('/videos');
    return (token ? req.set('Authorization', `Bearer ${token}`) : req).send(
      body,
    );
  };

  // 1.1 cria-rascunho-e-retorna-contrato-de-upload — AC #1, #5
  it('creates the draft and returns the upload contract', async () => {
    const res = await postVideo(validBody).expect(201);
    const body = res.body as { public_id: string };

    expect(body).toMatchObject({
      processing_status: 'uploading',
      title: 'aula',
      upload: { part_size: 67108864, part_count: 1 },
    });
    expect(body.public_id).toMatch(/^[A-Za-z0-9_-]{11}$/);

    const rows = await ctx.dataSource.query<
      {
        channel_id: string;
        published_at: Date | null;
        upload_id: string | null;
        title: string;
        declared_size: string;
        mime_type: string;
      }[]
    >('SELECT * FROM "videos" WHERE "public_id" = $1', [body.public_id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].channel_id).toBe(channelId);
    expect(rows[0].published_at).toBeNull();
    expect(rows[0].upload_id).toBeTruthy();
    expect(rows[0].title).toBe('aula');
    expect(Number(rows[0].declared_size)).toBe(1048576);
    expect(rows[0].mime_type).toBe('video/mp4');
  });

  // 2.1 rejeita-tamanho-acima-de-10-gib — AC #2
  it('rejects a size above 10 GiB', async () => {
    const res = await postVideo({ ...validBody, size: 10737418241 }).expect(
      400,
    );

    expect((res.body as { error: string }).error).toBe('VALIDATION_ERROR');
    expect(await ctx.dataSource.query('SELECT 1 FROM "videos"')).toHaveLength(
      0,
    );
  });

  // 2.2 rejeita-mime-fora-da-allowlist — AC #3
  it('rejects a MIME type outside the allowlist', async () => {
    const res = await postVideo({
      filename: 'foto.png',
      size: 1024,
      mime_type: 'image/png',
    }).expect(400);

    expect((res.body as { error: string }).error).toBe('VALIDATION_ERROR');
    expect(await ctx.dataSource.query('SELECT 1 FROM "videos"')).toHaveLength(
      0,
    );
  });

  // 3.1 sem-token-retorna-401 — AC #4
  it('returns 401 without an access token', async () => {
    await postVideo(validBody, null).expect(401);

    expect(await ctx.dataSource.query('SELECT 1 FROM "videos"')).toHaveLength(
      0,
    );
  });

  // 4.1 onze-chamadas-por-minuto-nao-recebem-429 — AC #6
  it('is not subject to the auth rate limit', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      statuses.push((await postVideo(validBody)).status);
    }

    expect(statuses.every((status) => status === 201)).toBe(true);
    expect(statuses).not.toContain(429);
  });
});
