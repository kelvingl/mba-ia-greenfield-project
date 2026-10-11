import { mkdtemp, rm, stat } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import storageConfig from '../../config/storage.config';
import { StorageModule } from '../../storage/storage.module';
import { StorageService } from '../../storage/storage.service';
import {
  createMediaFixtures,
  FIXTURE_DURATION_SECONDS,
  FIXTURE_HEIGHT,
  FIXTURE_WIDTH,
  jpegSize,
  MediaFixtures,
  removeMediaFixtures,
  topLevelBoxes,
} from '../../test/media';
import {
  emptyTestBucket,
  internalS3Client,
  TEST_BUCKET,
  useTestBucket,
} from '../../test/s3';
import { FfmpegService } from './ffmpeg.service';
import { PermanentMediaError } from './media.errors';

describe('FfmpegService (integration, real FFmpeg + MinIO)', () => {
  let module: TestingModule;
  let service: FfmpegService;
  let storage: StorageService;
  let fixtures: MediaFixtures;
  let outDir: string;

  beforeAll(async () => {
    useTestBucket();
    fixtures = await createMediaFixtures();
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
      providers: [FfmpegService],
    }).compile();
    service = module.get(FfmpegService);
    storage = module.get(StorageService);
  }, 120_000);

  beforeEach(async () => {
    outDir = await mkdtemp(join(tmpdir(), 'ffmpeg-out-'));
  });

  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  afterAll(async () => {
    await emptyTestBucket();
    await removeMediaFixtures(fixtures);
    await module.close();
  });

  describe('probe', () => {
    it('should read duration, dimensions and codecs of a local MP4', async () => {
      const result = await service.probe(fixtures.mp4);

      expect(result.durationSeconds).toBeGreaterThan(1.9);
      expect(result.durationSeconds).toBeLessThan(2.1);
      expect(result.width).toBe(FIXTURE_WIDTH);
      expect(result.height).toBe(FIXTURE_HEIGHT);
      expect(result.videoCodec).toBe('h264');
      expect(result.audioCodec).toBe('aac');
    });

    it('should report a missing audio stream as null', async () => {
      const result = await service.probe(fixtures.mp4NoAudio);

      expect(result.audioCodec).toBeNull();
    });

    it('should probe through an internal presigned URL (Range reads)', async () => {
      const key = 'originals/probe-test/source.mp4';
      await internalS3Client.send(
        new PutObjectCommand({
          Bucket: TEST_BUCKET,
          Key: key,
          Body: await readFile(fixtures.mp4),
        }),
      );

      const result = await service.probe(await storage.presignInternalGet(key));

      expect(result.durationSeconds).toBeCloseTo(FIXTURE_DURATION_SECONDS, 0);
      expect(result.videoCodec).toBe('h264');
    });

    it('should reject a file without a video stream as permanent', async () => {
      await expect(service.probe(fixtures.audioOnly)).rejects.toBeInstanceOf(
        PermanentMediaError,
      );
    });

    it('should reject random bytes as permanent', async () => {
      await expect(service.probe(fixtures.garbage)).rejects.toBeInstanceOf(
        PermanentMediaError,
      );
    });

    it('should not call an unreachable input permanent', async () => {
      const error = await service
        .probe(join(outDir, 'does-not-exist.mp4'))
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(PermanentMediaError);
    });
  });

  describe('extractThumbnail', () => {
    it('should write a 1280px wide JPEG keeping the aspect ratio', async () => {
      const out = join(outDir, 'thumb.jpg');

      await service.extractThumbnail(
        fixtures.mp4,
        FIXTURE_DURATION_SECONDS,
        out,
      );

      const { width, height } = await jpegSize(out);
      expect(width).toBe(1280);
      expect(height).toBe(720);
      expect(height % 2).toBe(0);
    });
  });

  describe('normalizeForPlayback', () => {
    it('should remux H.264/AAC moving moov before mdat without re-encoding', async () => {
      const out = join(outDir, 'playback.mp4');
      expect(await topLevelBoxes(fixtures.mp4)).toEqual(
        expect.arrayContaining(['moov', 'mdat']),
      );
      expect(
        (await topLevelBoxes(fixtures.mp4)).indexOf('moov'),
      ).toBeGreaterThan((await topLevelBoxes(fixtures.mp4)).indexOf('mdat'));

      await service.normalizeForPlayback(
        fixtures.mp4,
        await service.probe(fixtures.mp4),
        out,
      );

      const boxes = await topLevelBoxes(out);
      expect(boxes.indexOf('moov')).toBeLessThan(boxes.indexOf('mdat'));
      const result = await service.probe(out);
      expect(result.videoCodec).toBe('h264');
      expect(result.audioCodec).toBe('aac');
    });

    it('should transcode a WebM to H.264/AAC with faststart', async () => {
      const out = join(outDir, 'playback.mp4');

      await service.normalizeForPlayback(
        fixtures.webm,
        await service.probe(fixtures.webm),
        out,
      );

      const boxes = await topLevelBoxes(out);
      expect(boxes.indexOf('moov')).toBeLessThan(boxes.indexOf('mdat'));
      const result = await service.probe(out);
      expect(result.videoCodec).toBe('h264');
      expect(result.audioCodec).toBe('aac');
      expect(result.durationSeconds).toBeGreaterThan(1.8);
      expect((await stat(out)).size).toBeGreaterThan(0);
    });
  });
});
