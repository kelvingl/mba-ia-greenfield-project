import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { emptyTestBucket, TEST_BUCKET, useTestBucket } from '../test/s3';
import { InvalidUploadPartsError } from './storage.errors';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

const FIVE_MIB = 5 * 1024 * 1024;

async function buildService(): Promise<{
  module: TestingModule;
  service: StorageService;
}> {
  const module = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
      StorageModule,
    ],
  }).compile();
  return { module, service: module.get(StorageService) };
}

describe('StorageService (integration, real MinIO)', () => {
  const originalPublicEndpoint = process.env.S3_PUBLIC_ENDPOINT;
  let shapeModule: TestingModule;
  let shapeService: StorageService;
  let module: TestingModule;
  let service: StorageService;

  beforeAll(async () => {
    useTestBucket();
    // Public-endpoint service: used only to assert the shape of browser-facing
    // URLs. Its host (localhost) is not reachable from inside the container.
    ({ module: shapeModule, service: shapeService } = await buildService());

    // Round-trip service: presigned URLs are signed against the internal
    // endpoint so the test itself can PUT/GET through them.
    process.env.S3_PUBLIC_ENDPOINT = process.env.S3_ENDPOINT;
    ({ module, service } = await buildService());
    process.env.S3_PUBLIC_ENDPOINT = originalPublicEndpoint;
  });

  beforeEach(async () => {
    await emptyTestBucket();
  });

  afterAll(async () => {
    await module.close();
    await shapeModule.close();
  });

  async function putPart(url: string, body: Buffer): Promise<string> {
    const res = await fetch(url, { method: 'PUT', body: new Uint8Array(body) });
    expect(res.status).toBe(200);
    return res.headers.get('etag') as string;
  }

  it('should complete a 2-part multipart upload through presigned URLs', async () => {
    const key = 'originals/v1/source.mp4';
    const uploadId = await service.createMultipartUpload(key, 'video/mp4');
    const urls = await service.presignUploadParts(key, uploadId, [1, 2]);

    const etag1 = await putPart(urls[0].url, Buffer.alloc(FIVE_MIB, 1));
    const etag2 = await putPart(urls[1].url, Buffer.alloc(1024, 2));

    const parts = await service.listParts(key, uploadId);
    expect(parts).toEqual([
      { partNumber: 1, etag: etag1, size: FIVE_MIB },
      { partNumber: 2, etag: etag2, size: 1024 },
    ]);

    await service.completeMultipartUpload(key, uploadId, [
      { partNumber: 1, etag: etag1 },
      { partNumber: 2, etag: etag2 },
    ]);
    expect(await service.headObject(key)).toEqual({ size: FIVE_MIB + 1024 });
  });

  it('should throw a typed error when completing with a wrong ETag', async () => {
    const key = 'originals/v2/source.mp4';
    const uploadId = await service.createMultipartUpload(key, 'video/mp4');
    const [part] = await service.presignUploadParts(key, uploadId, [1]);
    await putPart(part.url, Buffer.alloc(1024));

    await expect(
      service.completeMultipartUpload(key, uploadId, [
        { partNumber: 1, etag: '"00000000000000000000000000000000"' },
      ]),
    ).rejects.toBeInstanceOf(InvalidUploadPartsError);
  });

  it('should serve byte ranges through a presigned GET with 206', async () => {
    const key = 'playback/v3.mp4';
    const file = join(await mkdtemp(join(tmpdir(), 'storage-')), 'p.mp4');
    await writeFile(file, Buffer.alloc(4096, 7));
    try {
      await service.putObjectFromFile(key, file, 'video/mp4');
    } finally {
      await rm(file, { force: true });
    }

    const url = await service.presignGet(key);
    const res = await fetch(url, { headers: { Range: 'bytes=0-1023' } });

    expect(res.status).toBe(206);
    expect(res.headers.get('content-length')).toBe('1024');
    expect(res.headers.get('content-range')).toBe('bytes 0-1023/4096');
  });

  it('should deliver the original as an attachment when asked', async () => {
    const key = 'originals/v4/source.mp4';
    const file = join(await mkdtemp(join(tmpdir(), 'storage-')), 'o.mp4');
    await writeFile(file, 'original-bytes');
    try {
      await service.putObjectFromFile(key, file, 'video/mp4');
    } finally {
      await rm(file, { force: true });
    }

    const url = await service.presignGet(key, {
      responseContentDisposition: 'attachment; filename="aula.mp4"',
    });
    expect(new URL(url).searchParams.get('response-content-disposition')).toBe(
      'attachment; filename="aula.mp4"',
    );
    const res = await fetch(url);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="aula.mp4"',
    );
    expect(await res.text()).toBe('original-bytes');
  });

  it('should serve thumbnails anonymously but keep originals private', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'storage-'));
    const file = join(dir, 't.jpg');
    await writeFile(file, 'jpeg-bytes');
    try {
      await service.putObjectFromFile('thumbnails/v5.jpg', file, 'image/jpeg');
      await service.putObjectFromFile(
        'originals/v5/source.mp4',
        file,
        'video/mp4',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    // publicObjectUrl is built from the public endpoint (host-only here), so
    // rebuild the same path against the internal endpoint to hit MinIO.
    const path = new URL(service.publicObjectUrl('thumbnails/v5.jpg')).pathname;
    expect((await fetch(`${process.env.S3_ENDPOINT}${path}`)).status).toBe(200);
    expect(
      (
        await fetch(
          `${process.env.S3_ENDPOINT}/${TEST_BUCKET}/originals/v5/source.mp4`,
        )
      ).status,
    ).toBe(403);
  });

  it('should sign browser-facing URLs against the public endpoint with the configured TTLs', async () => {
    const key = 'originals/v6/source.mp4';
    const uploadId = await shapeService.createMultipartUpload(key, 'video/mp4');

    const [part] = await shapeService.presignUploadParts(key, uploadId, [1]);
    const partUrl = new URL(part.url);
    expect(partUrl.origin).toBe(new URL(originalPublicEndpoint!).origin);
    expect(partUrl.searchParams.get('X-Amz-Expires')).toBe('3600');

    const getUrl = new URL(await shapeService.presignGet(key));
    expect(getUrl.origin).toBe(new URL(originalPublicEndpoint!).origin);
    expect(getUrl.searchParams.get('X-Amz-Expires')).toBe('900');

    expect(shapeService.publicObjectUrl('thumbnails/v6.jpg')).toBe(
      `${originalPublicEndpoint}/${TEST_BUCKET}/thumbnails/v6.jpg`,
    );
  });

  it('should report the size of and delete an object', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'storage-'));
    const file = join(dir, 'x.bin');
    await writeFile(file, Buffer.alloc(321));
    try {
      await service.putObjectFromFile(
        'originals/v7/source.bin',
        file,
        'video/mp4',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    expect(await service.headObject('originals/v7/source.bin')).toEqual({
      size: 321,
    });
    await service.deleteObject('originals/v7/source.bin');
    await expect(
      service.headObject('originals/v7/source.bin'),
    ).rejects.toMatchObject({ name: 'NotFound' });
  });
});
