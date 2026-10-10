import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import {
  ChannelNotFoundException,
  InvalidUploadPartsException,
  InvalidUploadStateException,
  VideoNotFoundException,
} from '../common/exceptions/domain.exception';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import {
  emptyTestBucket,
  internalS3Client,
  TEST_BUCKET,
  useTestBucket,
} from '../test/s3';
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { User } from '../users/entities/user.entity';
import { CreateVideoDto } from './dto/create-video.dto';
import { Video } from './entities/video.entity';
import { VideoProcessingStatus } from './videos.constants';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

describe('VideosService (integration, real Postgres + MinIO)', () => {
  let module: TestingModule;
  let service: VideosService;
  let storage: StorageService;
  let dataSource: DataSource;
  let videos: Repository<Video>;
  let userId: string;
  let channelId: string;

  const dto = (overrides: Partial<CreateVideoDto> = {}): CreateVideoDto =>
    Object.assign(new CreateVideoDto(), {
      filename: 'aula.mp4',
      size: 1048576,
      mime_type: 'video/mp4',
      ...overrides,
    });

  const originalPublicEndpoint = process.env.S3_PUBLIC_ENDPOINT;

  beforeAll(async () => {
    useTestBucket();
    // Presigned URLs must be reachable from inside the container for the
    // round trips below (the real public endpoint is a host address).
    process.env.S3_PUBLIC_ENDPOINT = process.env.S3_ENDPOINT;
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        TypeOrmModule.forRoot(
          createTestDataSource(
            [User, Channel, Video, RefreshToken, VerificationToken],
            { synchronize: false },
          ).options,
        ),
        VideosModule,
      ],
    }).compile();
    service = module.get(VideosService);
    storage = module.get(StorageService);
    dataSource = module.get(DataSource);
    videos = module.get(getRepositoryToken(Video));
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await emptyTestBucket();
    const user = await dataSource
      .getRepository(User)
      .save({ email: 'owner@example.com', password: 'hashed' });
    const channel = await dataSource
      .getRepository(Channel)
      .save({ name: 'owner', nickname: 'owner', user_id: user.id });
    userId = user.id;
    channelId = channel.id;
  });

  afterAll(async () => {
    process.env.S3_PUBLIC_ENDPOINT = originalPublicEndpoint;
    await cleanAllTables(dataSource);
    await module.close();
  });

  it('should persist the draft in the caller channel with a live multipart upload', async () => {
    const { video, partSize, partCount } = await service.createDraft(
      userId,
      dto(),
    );

    const row = await videos.findOneByOrFail({ id: video.id });
    expect(row.channel_id).toBe(channelId);
    expect(row.processing_status).toBe(VideoProcessingStatus.UPLOADING);
    expect(row.published_at).toBeNull();
    expect(row.title).toBe('aula');
    expect(row.declared_size).toBe(1048576);
    expect(row.original_key).toBe(`originals/${row.id}/source.mp4`);
    expect(partSize).toBe(67108864);
    expect(partCount).toBe(1);
    // The upload_id refers to a multipart upload that really exists in MinIO.
    await expect(
      storage.listParts(row.original_key, row.upload_id as string),
    ).resolves.toEqual([]);
  });

  it('should not leave a draft behind when the storage fails', async () => {
    jest
      .spyOn(storage, 'createMultipartUpload')
      .mockRejectedValueOnce(new Error('storage unavailable'));

    await expect(service.createDraft(userId, dto())).rejects.toThrow(
      'storage unavailable',
    );

    expect(await videos.count()).toBe(0);
  });

  it('should fail for a user that has no channel', async () => {
    await expect(
      service.createDraft('00000000-0000-4000-8000-000000000000', dto()),
    ).rejects.toBeInstanceOf(ChannelNotFoundException);
    expect(await videos.count()).toBe(0);
  });

  describe('upload control plane', () => {
    const FIVE_MIB = 5 * 1024 * 1024;

    async function putPart(url: string, size: number, fill: number) {
      const res = await fetch(url, {
        method: 'PUT',
        body: new Uint8Array(Buffer.alloc(size, fill)),
      });
      expect(res.status).toBe(200);
      return res.headers.get('etag') as string;
    }

    it('should sign parts, report them for resume and complete the upload', async () => {
      // 64 MiB + 1 KiB needs two parts. S3 only requires 5 MiB for every part
      // but the last, so the test sends a 5 MiB first part and a 1 KiB last one.
      const { video } = await service.createDraft(
        userId,
        dto({ size: 67108864 + 1024 }),
      );

      const { urls, expiresIn } = await service.signUploadParts(
        userId,
        video.public_id,
        [1, 2],
      );
      expect(expiresIn).toBe(3600);
      expect(urls.map((u) => u.partNumber)).toEqual([1, 2]);

      const etag1 = await putPart(urls[0].url, FIVE_MIB, 1);

      // Resume: only part 1 is stored so far.
      const midway = await service.listUploadedParts(userId, video.public_id);
      expect(midway.partCount).toBe(2);
      expect(midway.parts).toEqual([
        { partNumber: 1, etag: etag1, size: FIVE_MIB },
      ]);

      const etag2 = await putPart(urls[1].url, 1024, 2);
      await service.completeUpload(userId, video.public_id, [
        { partNumber: 1, etag: etag1 },
        { partNumber: 2, etag: etag2 },
      ]);

      const head = await internalS3Client.send(
        new HeadObjectCommand({ Bucket: TEST_BUCKET, Key: video.original_key }),
      );
      expect(head.ContentLength).toBe(FIVE_MIB + 1024);
      // complete does not move the video: the storage event does (SI-03.8).
      const row = await videos.findOneByOrFail({ id: video.id });
      expect(row.processing_status).toBe(VideoProcessingStatus.UPLOADING);
    });

    it('should reject completing with a tampered ETag', async () => {
      const { video } = await service.createDraft(userId, dto());
      const { urls } = await service.signUploadParts(
        userId,
        video.public_id,
        [1],
      );
      await putPart(urls[0].url, 1024, 3);

      await expect(
        service.completeUpload(userId, video.public_id, [
          { partNumber: 1, etag: '"00000000000000000000000000000000"' },
        ]),
      ).rejects.toBeInstanceOf(InvalidUploadPartsException);
    });

    it('should hide another user video and reject a video that is not uploading', async () => {
      const { video } = await service.createDraft(userId, dto());
      const stranger = await dataSource
        .getRepository(User)
        .save({ email: 'stranger@example.com', password: 'hashed' });
      await dataSource
        .getRepository(Channel)
        .save({ name: 'stranger', nickname: 'stranger', user_id: stranger.id });

      await expect(
        service.listUploadedParts(stranger.id, video.public_id),
      ).rejects.toBeInstanceOf(VideoNotFoundException);

      await videos.update(
        { id: video.id },
        { processing_status: VideoProcessingStatus.PROCESSING },
      );
      await expect(
        service.signUploadParts(userId, video.public_id, [1]),
      ).rejects.toBeInstanceOf(InvalidUploadStateException);
    });
  });
});
