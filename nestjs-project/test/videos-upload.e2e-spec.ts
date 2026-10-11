import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import request from 'supertest';
import { VIDEO_PROCESSING_QUEUE } from '../src/queue/queue.constants';
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

const MIB = 1024 * 1024;
const PART_SIZE = 64 * MIB;

// Spec: specs/videos-upload.plan.md (SI-03.7)
describe('videos-upload', () => {
  const originalPublicEndpoint = process.env.S3_PUBLIC_ENDPOINT;
  let ctx: E2eContext;
  let owner: { accessToken: string; userId: string };

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const http = () => request(ctx.app.getHttpServer());

  async function createDraft(size: number, token = owner.accessToken) {
    const res = await http()
      .post('/videos')
      .set(auth(token))
      .send({ filename: 'longo.mp4', size, mime_type: 'video/mp4' })
      .expect(201);
    return res.body as {
      public_id: string;
      upload: { part_size: number; part_count: number };
    };
  }

  async function signParts(publicId: string, partNumbers: number[]) {
    const res = await http()
      .post(`/videos/${publicId}/upload/part-urls`)
      .set(auth(owner.accessToken))
      .send({ part_numbers: partNumbers })
      .expect(200);
    return res.body as {
      urls: { part_number: number; url: string }[];
      expires_in: number;
    };
  }

  async function putPart(url: string, bytes: number): Promise<string> {
    const res = await fetch(url, {
      method: 'PUT',
      body: new Uint8Array(Buffer.alloc(bytes, 1)),
    });
    expect(res.status).toBe(200);
    return res.headers.get('etag') as string;
  }

  beforeAll(async () => {
    useTestBucket();
    // URLs signed for the host address are unreachable from the container.
    process.env.S3_PUBLIC_ENDPOINT = process.env.S3_ENDPOINT;
    // Isolate BullMQ keys from the worker running in the Compose stack.
    process.env.QUEUE_PREFIX = `test-${Date.now()}-videos-upload`;
    ctx = await createE2eApp();
  });

  beforeEach(async () => {
    await cleanAllTables(ctx.dataSource);
    await emptyTestBucket();
    ctx.throttlerStorage.storage.clear();
    owner = await createAuthenticatedUser(ctx, 'owner@example.com');
  });

  afterAll(async () => {
    process.env.S3_PUBLIC_ENDPOINT = originalPublicEndpoint;
    await cleanAllTables(ctx.dataSource);
    await ctx.app.close();
  });

  // 1.1 assina-partes-em-lote-com-ttl-de-1h — AC #1
  it('signs parts in a batch with a one-hour TTL', async () => {
    const draft = await createDraft(70_000_000);
    expect(draft.upload.part_count).toBe(2);

    const signed = await signParts(draft.public_id, [1, 2]);

    expect(signed.urls.map((u) => u.part_number)).toEqual([1, 2]);
    expect(signed.expires_in).toBe(3600);
    for (const { url } of signed.urls) {
      const parsed = new URL(url);
      expect(parsed.origin).toBe(
        new URL(process.env.S3_PUBLIC_ENDPOINT!).origin,
      );
      expect(parsed.searchParams.get('X-Amz-Expires')).toBe('3600');
    }
  });

  // 1.2 rejeita-numero-de-parte-fora-da-faixa — AC #2
  it('rejects a part number outside the range', async () => {
    const draft = await createDraft(MIB);

    const res = await http()
      .post(`/videos/${draft.public_id}/upload/part-urls`)
      .set(auth(owner.accessToken))
      .send({ part_numbers: [2] })
      .expect(400);

    expect((res.body as { error: string }).error).toBe('INVALID_PART_NUMBER');
  });

  describe('resume and complete', () => {
    let publicId: string;
    let etags: string[];

    beforeEach(async () => {
      const draft = await createDraft(PART_SIZE + 1024);
      publicId = draft.public_id;
      expect(draft.upload.part_count).toBe(2);
      const { urls } = await signParts(publicId, [1, 2]);
      etags = [
        await putPart(urls[0].url, PART_SIZE),
        await putPart(urls[1].url, 1024),
      ];
    });

    // 2.1 lista-partes-enviadas-para-retomada — AC #3
    it('lists the uploaded parts so the upload can resume', async () => {
      const res = await http()
        .get(`/videos/${publicId}/upload/parts`)
        .set(auth(owner.accessToken))
        .expect(200);
      const body = res.body as {
        part_size: number;
        part_count: number;
        parts: { part_number: number; etag: string; size: number }[];
      };

      expect(body.part_size).toBe(PART_SIZE);
      expect(body.part_count).toBe(2);
      expect(body.parts.map((p) => [p.part_number, p.etag])).toEqual([
        [1, etags[0]],
        [2, etags[1]],
      ]);
    });

    // 2.2 conclui-multipart-com-etags-corretos — AC #4
    it('completes the multipart upload without enqueueing processing', async () => {
      const res = await http()
        .post(`/videos/${publicId}/upload/complete`)
        .set(auth(owner.accessToken))
        .send({
          parts: [
            { part_number: 1, etag: etags[0] },
            { part_number: 2, etag: etags[1] },
          ],
        })
        .expect(202);
      expect(
        (res.body as { processing_status: string }).processing_status,
      ).toBe('uploading');

      const [row] = await ctx.dataSource.query<{ original_key: string }[]>(
        'SELECT "original_key" FROM "videos" WHERE "public_id" = $1',
        [publicId],
      );
      const head = await internalS3Client.send(
        new HeadObjectCommand({ Bucket: TEST_BUCKET, Key: row.original_key }),
      );
      expect(head.ContentLength).toBe(PART_SIZE + 1024);

      const queue: Queue = ctx.app.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
      expect(await queue.getWaitingCount()).toBe(0);
    });

    it('answers 202 again when complete is repeated after the object exists', async () => {
      const res = await http()
        .post(`/videos/${publicId}/upload/complete`)
        .set(auth(owner.accessToken))
        .send({
          parts: [
            { part_number: 1, etag: etags[0] },
            { part_number: 2, etag: etags[1] },
          ],
        })
        .expect(202);
      expect(
        (res.body as { processing_status: string }).processing_status,
      ).toBe('uploading');
    });

    // 2.3 rejeita-conclusao-com-etag-adulterado — AC #5
    it('rejects completion with a tampered ETag', async () => {
      const res = await http()
        .post(`/videos/${publicId}/upload/complete`)
        .set(auth(owner.accessToken))
        .send({
          parts: [
            { part_number: 1, etag: '"0000"' },
            { part_number: 2, etag: etags[1] },
          ],
        })
        .expect(400);

      expect((res.body as { error: string }).error).toBe(
        'INVALID_UPLOAD_PARTS',
      );
      const [row] = await ctx.dataSource.query<{ processing_status: string }[]>(
        'SELECT "processing_status" FROM "videos" WHERE "public_id" = $1',
        [publicId],
      );
      expect(row.processing_status).toBe('uploading');
    });
  });

  describe('access control', () => {
    // 3.1 nao-dono-recebe-404-em-todas-as-rotas — AC #6
    it('answers 404 to every route for a user who does not own the video', async () => {
      const draft = await createDraft(MIB);
      const stranger = await createAuthenticatedUser(
        ctx,
        'stranger@example.com',
      );
      const complete = { parts: [{ part_number: 1, etag: '"x"' }] };

      // Built lazily: supertest opens an ephemeral server per request.
      const attempts = [
        () =>
          http()
            .post(`/videos/${draft.public_id}/upload/part-urls`)
            .send({ part_numbers: [1] }),
        () => http().get(`/videos/${draft.public_id}/upload/parts`),
        () =>
          http()
            .post(`/videos/${draft.public_id}/upload/complete`)
            .send(complete),
      ];
      for (const attempt of attempts) {
        const res = await attempt().set(auth(stranger.accessToken)).expect(404);
        expect((res.body as { error: string }).error).toBe('VIDEO_NOT_FOUND');
      }

      const missing = await http()
        .get('/videos/AAAAAAAAAAA/upload/parts')
        .set(auth(stranger.accessToken))
        .expect(404);
      expect((missing.body as { error: string }).error).toBe('VIDEO_NOT_FOUND');
    });

    // 3.2 video-fora-de-uploading-retorna-409 — AC #7
    it('answers 409 when the video is no longer uploading', async () => {
      const draft = await createDraft(MIB);
      await ctx.dataSource.query(
        `UPDATE "videos" SET "processing_status" = 'processing' WHERE "public_id" = $1`,
        [draft.public_id],
      );
      const complete = { parts: [{ part_number: 1, etag: '"x"' }] };

      // Built lazily: supertest opens an ephemeral server per request.
      const attempts = [
        () =>
          http()
            .post(`/videos/${draft.public_id}/upload/part-urls`)
            .send({ part_numbers: [1] }),
        () => http().get(`/videos/${draft.public_id}/upload/parts`),
        () =>
          http()
            .post(`/videos/${draft.public_id}/upload/complete`)
            .send(complete),
      ];
      for (const attempt of attempts) {
        const res = await attempt().set(auth(owner.accessToken)).expect(409);
        expect((res.body as { error: string }).error).toBe(
          'INVALID_UPLOAD_STATE',
        );
      }
    });
  });
});
