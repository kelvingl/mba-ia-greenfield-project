import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import request from 'supertest';
import {
  MAINTENANCE_QUEUE,
  VIDEO_PROCESSING_QUEUE,
} from '../src/queue/queue.constants';
import { cleanAllTables } from '../src/test/create-test-data-source';
import {
  createMediaFixtures,
  MediaFixtures,
  removeMediaFixtures,
} from '../src/test/media';
import {
  emptyTestBucket,
  internalS3Client,
  TEST_BUCKET,
  useTestBucket,
} from '../src/test/s3';
import { waitFor } from '../src/test/wait-for';
import { WorkerModule } from '../src/worker.module';
import {
  createAuthenticatedUser,
  createE2eApp,
  E2eContext,
} from './helpers/e2e-app';

interface DraftResponse {
  public_id: string;
  upload: { part_size: number; part_count: number };
}

// Covers SI-03.14: the whole pipeline on the real Compose infrastructure, with
// the API and the worker both running in this process.
describe('videos-pipeline', () => {
  const originalPublicEndpoint = process.env.S3_PUBLIC_ENDPOINT;
  const token = process.env.STORAGE_WEBHOOK_TOKEN as string;
  let ctx: E2eContext;
  let worker: INestApplication;
  let queues: Queue[];
  let fixtures: MediaFixtures;
  let owner: { accessToken: string };

  const http = () => request(ctx.app.getHttpServer());
  const auth = () => ({ Authorization: `Bearer ${owner.accessToken}` });

  /** Uploads `bytes` straight to the storage in presigned parts, like a client. */
  async function uploadVideo(bytes: Buffer) {
    const draft = (
      await http()
        .post('/videos')
        .set(auth())
        .send({
          filename: 'aula.mp4',
          size: bytes.length,
          mime_type: 'video/mp4',
        })
        .expect(201)
    ).body as DraftResponse;
    const { part_size, part_count } = draft.upload;

    const numbers = Array.from({ length: part_count }, (_, i) => i + 1);
    const signed = (
      await http()
        .post(`/videos/${draft.public_id}/upload/part-urls`)
        .set(auth())
        .send({ part_numbers: numbers })
        .expect(200)
    ).body as { urls: { part_number: number; url: string }[] };

    const parts: { part_number: number; etag: string }[] = [];
    for (const { part_number, url } of signed.urls) {
      const slice = bytes.subarray(
        (part_number - 1) * part_size,
        part_number * part_size,
      );
      const res = await fetch(url, {
        method: 'PUT',
        body: new Uint8Array(slice),
      });
      expect(res.status).toBe(200);
      parts.push({ part_number, etag: res.headers.get('etag') as string });
    }
    await http()
      .post(`/videos/${draft.public_id}/upload/complete`)
      .set(auth())
      .send({ parts })
      .expect(202);

    const [{ id }] = await ctx.dataSource.query<{ id: string }[]>(
      'SELECT "id" FROM "videos" WHERE "public_id" = $1',
      [draft.public_id],
    );
    return { publicId: draft.public_id, id };
  }

  /** Delivers the bucket notification the way MinIO would. */
  async function deliverStorageEvent(videoId: string) {
    const key = `originals/${videoId}/source.mp4`;
    const head = await internalS3Client.send(
      new HeadObjectCommand({ Bucket: TEST_BUCKET, Key: key }),
    );
    await http()
      .post('/internal/storage-events')
      .set('Authorization', `Bearer ${token}`)
      .send({
        EventName: 's3:ObjectCreated:CompleteMultipartUpload',
        Records: [
          {
            eventName: 's3:ObjectCreated:CompleteMultipartUpload',
            s3: {
              object: {
                key: encodeURIComponent(key),
                size: head.ContentLength,
              },
            },
          },
        ],
      })
      .expect(204);
  }

  const statusOf = async (publicId: string) =>
    (await http().get(`/videos/${publicId}`).set(auth()).expect(200)).body as {
      processing_status: string;
      failure_reason: string | null;
    };

  /** Records every distinct status the row goes through, starting now. */
  async function trackStatuses(videoId: string) {
    const seen: string[] = [];
    const sample = async () => {
      const [row] = await ctx.dataSource.query<{ processing_status: string }[]>(
        'SELECT "processing_status" FROM "videos" WHERE "id" = $1',
        [videoId],
      );
      if (row && seen[seen.length - 1] !== row.processing_status) {
        seen.push(row.processing_status);
      }
    };
    await sample(); // the first state is read before anything can change it
    const timer = setInterval(() => void sample(), 15);
    return { seen, stop: () => clearInterval(timer) };
  }

  beforeAll(async () => {
    useTestBucket();
    // URLs signed for the host address are unreachable from the container.
    process.env.S3_PUBLIC_ENDPOINT = process.env.S3_ENDPOINT;
    // Isolates the queues from the worker container of the Compose stack.
    process.env.QUEUE_PREFIX = `test-${Date.now()}-videos-pipeline`;
    fixtures = await createMediaFixtures();

    ctx = await createE2eApp();
    const workerModule = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
    worker = workerModule.createNestApplication();
    await worker.init();
    queues = [VIDEO_PROCESSING_QUEUE, MAINTENANCE_QUEUE].map((name) =>
      worker.get<Queue>(getQueueToken(name)),
    );
  }, 120_000);

  beforeEach(async () => {
    await cleanAllTables(ctx.dataSource);
    await emptyTestBucket();
    ctx.throttlerStorage.storage.clear();
    owner = await createAuthenticatedUser(ctx, 'owner@example.com');
  });

  afterAll(async () => {
    process.env.S3_PUBLIC_ENDPOINT = originalPublicEndpoint;
    await Promise.all(queues.map((queue) => queue.obliterate({ force: true })));
    await emptyTestBucket();
    await cleanAllTables(ctx.dataSource);
    await worker.close();
    await ctx.app.close();
    await removeMediaFixtures(fixtures);
  });

  it('takes an uploaded video to ready, then streams and downloads it', async () => {
    const bytes = await readFile(fixtures.mp4);
    const { publicId, id } = await uploadVideo(bytes);
    const tracker = await trackStatuses(id);

    await deliverStorageEvent(id);
    await waitFor(
      async () => (await statusOf(publicId)).processing_status === 'ready',
      {
        timeoutMs: 30_000,
      },
    );
    tracker.stop();

    expect(tracker.seen).toEqual(['uploading', 'processing', 'ready']);
    const status = (
      await http().get(`/videos/${publicId}`).set(auth()).expect(200)
    ).body as { duration_seconds: number; thumbnail_url: string };
    expect(status.duration_seconds).toBeGreaterThan(1.9);
    expect((await fetch(status.thumbnail_url)).status).toBe(200);

    const playback = (
      await http()
        .get(`/videos/${publicId}/playback-url`)
        .set(auth())
        .expect(200)
    ).body as { url: string };
    const ranged = await fetch(playback.url, {
      headers: { Range: 'bytes=0-1023' },
    });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('content-range')).toMatch(/^bytes 0-1023\//);

    const download = (
      await http()
        .get(`/videos/${publicId}/download-url`)
        .set(auth())
        .expect(200)
    ).body as { url: string };
    const original = await fetch(download.url);
    expect(original.headers.get('content-disposition')).toMatch(/^attachment/);
    expect(Buffer.from(await original.arrayBuffer())).toEqual(bytes);
  }, 90_000);

  it('fails a file that is not a video with not_a_video', async () => {
    const { publicId, id } = await uploadVideo(randomBytes(64 * 1024));

    await deliverStorageEvent(id);
    await waitFor(
      async () => (await statusOf(publicId)).processing_status === 'failed',
      {
        timeoutMs: 30_000,
      },
    );

    expect((await statusOf(publicId)).failure_reason).toBe('not_a_video');
    const playback = await http()
      .get(`/videos/${publicId}/playback-url`)
      .set(auth());
    expect(playback.status).toBe(409);
    expect((playback.body as { error: string }).error).toBe('VIDEO_NOT_READY');
  }, 90_000);
});
