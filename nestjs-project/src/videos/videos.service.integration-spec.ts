import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import { ChannelNotFoundException } from '../common/exceptions/domain.exception';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { emptyTestBucket, useTestBucket } from '../test/s3';
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

  beforeAll(async () => {
    useTestBucket();
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
});
