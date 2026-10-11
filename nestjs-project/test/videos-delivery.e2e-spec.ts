import { PutObjectCommand } from '@aws-sdk/client-s3';
import request from 'supertest';
import { cleanAllTables } from '../src/test/create-test-data-source';
import {
  emptyTestBucket,
  internalS3Client,
  TEST_BUCKET,
  useTestBucket,
} from '../src/test/s3';
import {
  createAuthenticatedUser,
  createE2eApp,
  E2eContext,
} from './helpers/e2e-app';

const ORIGINAL = Buffer.alloc(4096, 9);

// Spec: specs/videos-delivery.plan.md (SI-03.12)
describe('videos-delivery', () => {
  const originalPublicEndpoint = process.env.S3_PUBLIC_ENDPOINT;
  let ctx: E2eContext;
  let owner: { accessToken: string };
  let stranger: { accessToken: string };

  const http = () => request(ctx.app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const get = (path: string, token = owner.accessToken) =>
    http().get(path).set(auth(token));

  async function createDraft() {
    const res = await http()
      .post('/videos')
      .set(auth(owner.accessToken))
      .send({ filename: 'aula.mp4', size: 1048576, mime_type: 'video/mp4' })
      .expect(201);
    const { public_id } = res.body as { public_id: string };
    const [row] = await ctx.dataSource.query<{ id: string; title: string }[]>(
      'SELECT "id", "title" FROM "videos" WHERE "public_id" = $1',
      [public_id],
    );
    return { publicId: public_id, id: row.id, title: row.title };
  }

  /** Turns a draft into a `ready` video and writes its three objects. */
  async function makeReady(draft: { id: string }) {
    const put = (key: string, body: Buffer) =>
      internalS3Client.send(
        new PutObjectCommand({
          Bucket: TEST_BUCKET,
          Key: key,
          Body: body,
          ContentType: key.endsWith('.jpg') ? 'image/jpeg' : 'video/mp4',
        }),
      );
    await put(`originals/${draft.id}/source.mp4`, ORIGINAL);
    await put(`playback/${draft.id}.mp4`, Buffer.alloc(4096, 1));
    await put(`thumbnails/${draft.id}.jpg`, Buffer.from('jpeg-bytes'));
    await ctx.dataSource.query(
      `UPDATE "videos" SET "processing_status" = 'ready', "upload_id" = NULL,
         "playback_key" = $2, "thumbnail_key" = $3,
         "duration_seconds" = 2, "width" = 640, "height" = 360
       WHERE "id" = $1`,
      [draft.id, `playback/${draft.id}.mp4`, `thumbnails/${draft.id}.jpg`],
    );
  }

  beforeAll(async () => {
    useTestBucket();
    // URLs signed for the host address are unreachable from the container.
    process.env.S3_PUBLIC_ENDPOINT = process.env.S3_ENDPOINT;
    process.env.QUEUE_PREFIX = `test-${Date.now()}-videos-delivery`;
    ctx = await createE2eApp();
  });

  beforeEach(async () => {
    await cleanAllTables(ctx.dataSource);
    await emptyTestBucket();
    ctx.throttlerStorage.storage.clear();
    owner = await createAuthenticatedUser(ctx, 'owner@example.com');
    stranger = await createAuthenticatedUser(ctx, 'stranger@example.com');
  });

  afterAll(async () => {
    process.env.S3_PUBLIC_ENDPOINT = originalPublicEndpoint;
    await cleanAllTables(ctx.dataSource);
    await ctx.app.close();
  });

  // 1.1 status-de-video-ainda-nao-pronto — AC #1
  it('reports a draft that is not ready yet', async () => {
    const draft = await createDraft();

    const res = await get(`/videos/${draft.publicId}`).expect(200);

    expect(res.body).toMatchObject({
      public_id: draft.publicId,
      title: draft.title,
      processing_status: 'uploading',
      failure_reason: null,
      published_at: null,
      thumbnail_url: null,
    });
  });

  // 1.2 status-de-video-pronto-com-thumbnail-publico — AC #2
  it('reports a ready video with a public thumbnail', async () => {
    const draft = await createDraft();
    await makeReady(draft);

    const res = await get(`/videos/${draft.publicId}`).expect(200);

    const body = res.body as {
      processing_status: string;
      duration_seconds: number;
      width: number;
      height: number;
      thumbnail_url: string;
    };
    expect(body.processing_status).toBe('ready');
    expect(body.duration_seconds).toBe(2);
    expect(body.width).toBe(640);
    expect(body.height).toBe(360);
    expect(body.thumbnail_url).toContain(`/thumbnails/${draft.id}.jpg`);
    expect(body.thumbnail_url).not.toContain('X-Amz-Signature');

    const thumbnail = await fetch(body.thumbnail_url);
    expect(thumbnail.status).toBe(200);
    expect(thumbnail.headers.get('content-type')).toBe('image/jpeg');
  });

  // 2.1 playback-url-permite-streaming-por-range — AC #3
  it('streams the playback file by Range', async () => {
    const draft = await createDraft();
    await makeReady(draft);

    const res = await get(`/videos/${draft.publicId}/playback-url`).expect(200);

    const { url, expires_in } = res.body as { url: string; expires_in: number };
    expect(url).toContain(`playback/${draft.id}.mp4`);
    expect(expires_in).toBeGreaterThan(0);
    const ranged = await fetch(url, { headers: { Range: 'bytes=0-1023' } });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('content-length')).toBe('1024');
    expect(ranged.headers.get('content-range')).toBe('bytes 0-1023/4096');
  });

  // 2.2 download-url-entrega-o-original-como-anexo — AC #4
  it('delivers the original as an attachment', async () => {
    const draft = await createDraft();
    await makeReady(draft);

    const res = await get(`/videos/${draft.publicId}/download-url`).expect(200);

    const { url } = res.body as { url: string };
    expect(new URL(url).searchParams.has('response-content-disposition')).toBe(
      true,
    );
    const file = await fetch(url);
    expect(file.status).toBe(200);
    const disposition = file.headers.get('content-disposition') as string;
    expect(disposition.startsWith('attachment')).toBe(true);
    expect(disposition).toContain(`filename="${draft.title}.mp4"`);
    expect(Buffer.from(await file.arrayBuffer())).toEqual(ORIGINAL);
  });

  // 3.1 playback-e-download-antes-de-pronto-retornam-409 — AC #5
  it('refuses playback and download before the video is ready', async () => {
    const uploading = await createDraft();
    const processing = await createDraft();
    await ctx.dataSource.query(
      `UPDATE "videos" SET "processing_status" = 'processing' WHERE "id" = $1`,
      [processing.id],
    );

    const playback = await get(`/videos/${uploading.publicId}/playback-url`);
    const download = await get(`/videos/${processing.publicId}/download-url`);

    for (const res of [playback, download]) {
      expect(res.status).toBe(409);
      expect((res.body as { error: string }).error).toBe('VIDEO_NOT_READY');
    }
  });

  // 3.2 nao-dono-recebe-404-indistinguivel-de-inexistente — AC #6
  it('answers a non-owner exactly as for a missing video', async () => {
    const draft = await createDraft();
    await makeReady(draft);

    const foreign = await Promise.all(
      [
        `/videos/${draft.publicId}`,
        `/videos/${draft.publicId}/playback-url`,
        `/videos/${draft.publicId}/download-url`,
      ].map((path) => get(path, stranger.accessToken)),
    );
    const missing = await get('/videos/AAAAAAAAAAA', stranger.accessToken);

    expect(missing.status).toBe(404);
    expect((missing.body as { error: string }).error).toBe('VIDEO_NOT_FOUND');
    for (const res of foreign) {
      expect(res.status).toBe(404);
      expect(res.body).toEqual(missing.body);
    }
  });
});
