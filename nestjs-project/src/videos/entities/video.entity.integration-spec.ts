import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import { createTestDataSource } from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { VideoProcessingStatus } from '../videos.constants';
import { Video } from './video.entity';

describe('Video entity (integration, schema created by the migration)', () => {
  let dataSource: DataSource;
  let videos: Repository<Video>;
  let channelId: string;

  const buildVideo = (overrides: Partial<Video> = {}): Partial<Video> => ({
    public_id: 'abcDEF12_-x',
    channel_id: channelId,
    title: 'aula',
    original_filename: 'aula.mp4',
    mime_type: 'video/mp4',
    declared_size: 1048576,
    original_key: 'originals/id/source.mp4',
    ...overrides,
  });

  beforeAll(async () => {
    // synchronize:false — the table must come from the CreateVideos migration.
    dataSource = createTestDataSource(
      [User, Channel, Video, RefreshToken, VerificationToken],
      { synchronize: false },
    );
    await dataSource.initialize();
    videos = dataSource.getRepository(Video);
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM "videos"');
    await dataSource.query('DELETE FROM "refresh_tokens"');
    await dataSource.query('DELETE FROM "verification_tokens"');
    await dataSource.query('DELETE FROM "channels"');
    await dataSource.query('DELETE FROM "users"');
    const user = await dataSource.getRepository(User).save({
      email: 'owner@example.com',
      password: 'hashed',
    });
    const channel = await dataSource.getRepository(Channel).save({
      name: 'owner',
      nickname: 'owner',
      user_id: user.id,
    });
    channelId = channel.id;
  });

  afterAll(async () => {
    await dataSource.query('DELETE FROM "videos"');
    await dataSource.destroy();
  });

  it('should create the video as a draft: uploading and unpublished', async () => {
    const saved = await videos.save(videos.create(buildVideo()));

    const found = await videos.findOneByOrFail({ id: saved.id });
    expect(found.processing_status).toBe(VideoProcessingStatus.UPLOADING);
    expect(found.published_at).toBeNull();
    expect(found.failure_reason).toBeNull();
    expect(found.created_at).toBeInstanceOf(Date);
  });

  it('should map bigint and numeric columns to numbers', async () => {
    const saved = await videos.save(
      videos.create(
        buildVideo({ declared_size: 10737418240, duration_seconds: 125.5 }),
      ),
    );

    const found = await videos.findOneByOrFail({ id: saved.id });
    expect(found.declared_size).toBe(10737418240);
    expect(found.duration_seconds).toBe(125.5);
  });

  it('should reject a duplicated public_id', async () => {
    await videos.save(videos.create(buildVideo()));

    await expect(
      videos.save(
        videos.create(buildVideo({ original_key: 'originals/b/source.mp4' })),
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('should reject a channel_id that does not exist', async () => {
    await expect(
      videos.save(
        videos.create(
          buildVideo({ channel_id: '00000000-0000-4000-8000-000000000000' }),
        ),
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('should only accept the four processing statuses', async () => {
    await expect(
      dataSource.query(
        `INSERT INTO "videos" ("public_id","channel_id","title","original_filename","mime_type","declared_size","original_key","processing_status")
         VALUES ('zzzzzzzzzzz', $1, 't', 'f.mp4', 'video/mp4', 1, 'k', 'published')`,
        [channelId],
      ),
    ).rejects.toMatchObject({ code: '22P02' });

    for (const status of Object.values(VideoProcessingStatus)) {
      await dataSource.query('DELETE FROM "videos"');
      await expect(
        videos.save(videos.create(buildVideo({ processing_status: status }))),
      ).resolves.toBeDefined();
    }
  });
});
