import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { ChannelNotFoundException } from '../common/exceptions/domain.exception';
import { StorageService } from '../storage/storage.service';
import { Video } from './entities/video.entity';
import { CreateVideoDto } from './dto/create-video.dto';
import { VideosService } from './videos.service';

const uniqueViolation = (column: string) =>
  new QueryFailedError(
    'INSERT',
    [],
    Object.assign(new Error('duplicate'), {
      code: '23505',
      detail: `Key (${column})=(x) already exists.`,
    }),
  );

describe('VideosService', () => {
  const repo = {
    create: jest.fn((data: Partial<Video>) => ({ ...data })),
    save: jest.fn((video: Partial<Video>) => Promise.resolve(video)),
    delete: jest.fn(() => Promise.resolve()),
  };
  const storage = { createMultipartUpload: jest.fn() };
  const channels = { findByUserId: jest.fn() };
  let service: VideosService;

  const dto = (overrides: Partial<CreateVideoDto> = {}): CreateVideoDto =>
    Object.assign(new CreateVideoDto(), {
      filename: 'aula.mp4',
      size: 1048576,
      mime_type: 'video/mp4',
      ...overrides,
    });

  beforeEach(async () => {
    jest.clearAllMocks();
    channels.findByUserId.mockResolvedValue({ id: 'channel-1' });
    storage.createMultipartUpload.mockResolvedValue('upload-1');
    repo.save.mockImplementation((video: Partial<Video>) =>
      Promise.resolve(video),
    );

    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: repo },
        { provide: StorageService, useValue: storage },
        { provide: ChannelsService, useValue: channels },
      ],
    }).compile();
    service = module.get(VideosService);
  });

  describe('createDraft', () => {
    it('should create the draft in the caller channel and open the multipart upload', async () => {
      const result = await service.createDraft('user-1', dto());

      expect(channels.findByUserId).toHaveBeenCalledWith('user-1');
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          channel_id: 'channel-1',
          original_filename: 'aula.mp4',
          mime_type: 'video/mp4',
          declared_size: 1048576,
        }),
      );
      expect(storage.createMultipartUpload).toHaveBeenCalledWith(
        expect.stringMatching(/^originals\/[0-9a-f-]{36}\/source\.mp4$/),
        'video/mp4',
      );
      expect(result.video.upload_id).toBe('upload-1');
      expect(result.video.public_id).toMatch(/^[A-Za-z0-9_-]{11}$/);
    });

    it('should derive the title from the filename without extension', async () => {
      const result = await service.createDraft(
        'user-1',
        dto({ filename: 'Minha aula.final.mp4' }),
      );
      expect(result.video.title).toBe('Minha aula.final');
    });

    it('should truncate a derived title to 100 characters', async () => {
      const result = await service.createDraft(
        'user-1',
        dto({ filename: `${'a'.repeat(150)}.mp4` }),
      );
      expect(result.video.title).toBe('a'.repeat(100));
    });

    it('should use a fallback title when the filename has no name', async () => {
      const result = await service.createDraft(
        'user-1',
        dto({ filename: '.mp4' }),
      );
      expect(result.video.title).toBe('Untitled video');
    });

    it('should keep an explicit title', async () => {
      const result = await service.createDraft(
        'user-1',
        dto({ title: 'Meu título' }),
      );
      expect(result.video.title).toBe('Meu título');
    });

    it.each([
      [1, 1],
      [67108864, 1],
      [67108865, 2],
      [10737418240, 160],
    ])(
      'should report %i bytes as %i part(s) of 64 MiB',
      async (size, parts) => {
        const result = await service.createDraft('user-1', dto({ size }));

        expect(result.partSize).toBe(67108864);
        expect(result.partCount).toBe(parts);
      },
    );

    it('should retry with a new public_id when it collides', async () => {
      repo.save
        .mockRejectedValueOnce(uniqueViolation('public_id'))
        .mockImplementation((video: Partial<Video>) => Promise.resolve(video));

      const result = await service.createDraft('user-1', dto());

      expect(repo.create).toHaveBeenCalledTimes(2);
      const ids = (repo.create.mock.calls as [Partial<Video>][]).map(
        ([created]) => created.public_id,
      );
      expect(ids[0]).not.toBe(ids[1]);
      expect(result.video.public_id).toBe(ids[1]);
    });

    it('should not swallow a unique violation on another column', async () => {
      repo.save.mockRejectedValueOnce(uniqueViolation('original_key'));

      await expect(service.createDraft('user-1', dto())).rejects.toBeInstanceOf(
        QueryFailedError,
      );
      expect(repo.create).toHaveBeenCalledTimes(1);
    });

    it('should give up after repeated public_id collisions', async () => {
      repo.save.mockRejectedValue(uniqueViolation('public_id'));

      await expect(service.createDraft('user-1', dto())).rejects.toBeInstanceOf(
        QueryFailedError,
      );
      expect(storage.createMultipartUpload).not.toHaveBeenCalled();
    });

    it('should delete the draft when the storage refuses the multipart upload', async () => {
      storage.createMultipartUpload.mockRejectedValue(
        new Error('storage down'),
      );

      await expect(service.createDraft('user-1', dto())).rejects.toThrow(
        'storage down',
      );
      expect(repo.delete).toHaveBeenCalledWith({
        id: expect.stringMatching(/^[0-9a-f-]{36}$/) as string,
      });
    });

    it('should fail when the user has no channel', async () => {
      channels.findByUserId.mockResolvedValue(null);

      await expect(service.createDraft('user-1', dto())).rejects.toBeInstanceOf(
        ChannelNotFoundException,
      );
      expect(repo.create).not.toHaveBeenCalled();
    });
  });
});
