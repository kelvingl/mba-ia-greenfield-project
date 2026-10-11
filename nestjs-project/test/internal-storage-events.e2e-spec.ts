import { HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import request from 'supertest';
import { VIDEO_PROCESSING_QUEUE } from '../src/queue/queue.constants';
import { buildSwaggerDocument } from '../src/swagger/swagger-document';
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

interface VideoRow {
  processing_status: string;
  size: string | null;
  upload_id: string | null;
  failure_reason: string | null;
  updated_at: Date;
}

// Spec: specs/internal-storage-events.plan.md (SI-03.8)
describe('internal-storage-events', () => {
  let ctx: E2eContext;
  let queue: Queue;
  let owner: { accessToken: string };

  const token = process.env.STORAGE_WEBHOOK_TOKEN as string;
  const http = () => request(ctx.app.getHttpServer());

  async function createDraft(size = MIB) {
    const res = await http()
      .post('/videos')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ filename: 'aula.mp4', size, mime_type: 'video/mp4' })
      .expect(201);
    const { public_id } = res.body as { public_id: string };
    const [row] = await ctx.dataSource.query<{ id: string }[]>(
      'SELECT "id" FROM "videos" WHERE "public_id" = $1',
      [public_id],
    );
    return row.id;
  }

  const objectKey = (videoId: string) => `originals/${videoId}/source.mp4`;

  async function putOriginal(videoId: string, bytes: number) {
    await internalS3Client.send(
      new PutObjectCommand({
        Bucket: TEST_BUCKET,
        Key: objectKey(videoId),
        Body: Buffer.alloc(bytes, 1),
      }),
    );
  }

  const eventFor = (videoId: string, size: number) => ({
    EventName: 's3:ObjectCreated:CompleteMultipartUpload',
    Key: `${TEST_BUCKET}/${objectKey(videoId)}`,
    Records: [
      {
        eventName: 's3:ObjectCreated:CompleteMultipartUpload',
        s3: {
          bucket: { name: TEST_BUCKET },
          object: { key: encodeURIComponent(objectKey(videoId)), size },
        },
      },
    ],
  });

  const deliver = (body: object, authorization = `Bearer ${token}`) =>
    http()
      .post('/internal/storage-events')
      .set('Authorization', authorization)
      .send(body);

  const videoRow = async (id: string) => {
    const [row] = await ctx.dataSource.query<VideoRow[]>(
      'SELECT * FROM "videos" WHERE "id" = $1',
      [id],
    );
    return row;
  };

  beforeAll(async () => {
    useTestBucket();
    process.env.S3_PUBLIC_ENDPOINT = process.env.S3_ENDPOINT;
    // Isolates BullMQ keys from the worker of the Compose stack; no worker runs
    // in-process, so jobs stay `waiting` and can be inspected.
    process.env.QUEUE_PREFIX = `test-${Date.now()}-storage-events`;
    ctx = await createE2eApp();
    queue = ctx.app.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
  });

  beforeEach(async () => {
    await cleanAllTables(ctx.dataSource);
    await emptyTestBucket();
    await queue.obliterate({ force: true });
    ctx.throttlerStorage.storage.clear();
    owner = await createAuthenticatedUser(ctx, 'owner@example.com');
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await ctx.app.close();
  });

  describe('webhook authentication', () => {
    it('should reject a missing or wrong token without side effects', async () => {
      const videoId = await createDraft();
      await putOriginal(videoId, MIB);
      const event = eventFor(videoId, MIB);

      const missing = await http().post('/internal/storage-events').send(event);
      const wrong = await deliver(event, 'Bearer wrong-token');

      for (const res of [missing, wrong]) {
        expect(res.status).toBe(401);
        expect((res.body as { error: string }).error).toBe(
          'INVALID_WEBHOOK_TOKEN',
        );
      }
      expect((await videoRow(videoId)).processing_status).toBe('uploading');
      expect(await queue.getWaitingCount()).toBe(0);
    });
  });

  describe('upload completion', () => {
    it('should move a valid upload to processing and enqueue it once', async () => {
      const videoId = await createDraft();
      await putOriginal(videoId, MIB);

      await deliver(eventFor(videoId, MIB)).expect(204);

      const row = await videoRow(videoId);
      expect(row.processing_status).toBe('processing');
      expect(Number(row.size)).toBe(MIB);
      expect(row.upload_id).toBeNull();
      const jobs = await queue.getWaiting();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].name).toBe('process-video');
      expect(jobs[0].id).toBe(videoId);
      expect(jobs[0].data).toEqual({ videoId });
    });

    it('should not enqueue a second job for a duplicated event', async () => {
      const videoId = await createDraft();
      await putOriginal(videoId, MIB);
      const event = eventFor(videoId, MIB);

      await deliver(event).expect(204);
      const afterFirst = await videoRow(videoId);
      await deliver(event).expect(204);

      expect(await queue.getWaitingCount()).toBe(1);
      const afterSecond = await videoRow(videoId);
      expect(afterSecond.processing_status).toBe('processing');
      expect(afterSecond.updated_at).toEqual(afterFirst.updated_at);
    });

    it('should delete an object larger than declared and mark file_too_large', async () => {
      const videoId = await createDraft(MIB);
      await putOriginal(videoId, 2 * MIB);

      await deliver(eventFor(videoId, 2 * MIB)).expect(204);

      await expect(
        internalS3Client.send(
          new HeadObjectCommand({
            Bucket: TEST_BUCKET,
            Key: objectKey(videoId),
          }),
        ),
      ).rejects.toMatchObject({ name: 'NotFound' });
      const row = await videoRow(videoId);
      expect(row.processing_status).toBe('failed');
      expect(row.failure_reason).toBe('file_too_large');
      expect(await queue.getWaitingCount()).toBe(0);
    });
  });

  describe('public contract', () => {
    it('should keep the webhook out of the OpenAPI document', () => {
      const { paths } = buildSwaggerDocument(ctx.app);

      expect(paths).not.toHaveProperty('/internal/storage-events');
      expect(paths).toHaveProperty('/videos');
    });
  });
});
