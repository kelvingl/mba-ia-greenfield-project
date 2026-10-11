import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  ChannelNotFoundException,
  InvalidPartNumberException,
  InvalidUploadPartsException,
  InvalidUploadStateException,
  VideoNotFoundException,
  VideoNotReadyException,
} from '../common/exceptions/domain.exception';
import { InvalidUploadPartsError } from '../storage/storage.errors';
import { StorageService } from '../storage/storage.service';
import { Video } from './entities/video.entity';
import { CreateVideoDto } from './dto/create-video.dto';
import { VideoProcessingStatus } from './videos.constants';
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
    findOne: jest.fn(),
  };
  const storage = {
    createMultipartUpload: jest.fn(),
    presignUploadParts: jest.fn(),
    listParts: jest.fn(),
    completeMultipartUpload: jest.fn(),
    objectExists: jest.fn(),
    partUrlTtlSeconds: 3600,
    deliveryUrlTtlSeconds: 900,
    publicObjectUrl: jest.fn(),
    presignGet: jest.fn(),
  };
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

  describe('upload control plane', () => {
    const owned = (overrides: Partial<Video> = {}): Partial<Video> => ({
      id: 'video-1',
      public_id: 'abcDEF12_-x',
      processing_status: VideoProcessingStatus.UPLOADING,
      upload_id: 'upload-1',
      original_key: 'originals/video-1/source.mp4',
      declared_size: 67108864 + 1024, // 2 parts
      ...overrides,
    });

    describe('ownership', () => {
      it('should look the video up through the caller channel', async () => {
        repo.findOne.mockResolvedValue(owned());

        await service.listUploadedParts('user-1', 'abcDEF12_-x').catch(() => 0);

        expect(repo.findOne).toHaveBeenCalledWith({
          where: { public_id: 'abcDEF12_-x', channel: { user_id: 'user-1' } },
        });
      });

      it.each([
        [
          'signUploadParts',
          (s: VideosService) => s.signUploadParts('u', 'p', [1]),
        ],
        [
          'listUploadedParts',
          (s: VideosService) => s.listUploadedParts('u', 'p'),
        ],
        [
          'completeUpload',
          (s: VideosService) => s.completeUpload('u', 'p', []),
        ],
      ])(
        '%s should answer not found for a missing or foreign video',
        async (_n, call) => {
          repo.findOne.mockResolvedValue(null);

          await expect(call(service)).rejects.toBeInstanceOf(
            VideoNotFoundException,
          );
        },
      );
    });

    describe('state guard', () => {
      it.each([
        [
          'not uploading',
          owned({ processing_status: VideoProcessingStatus.PROCESSING }),
        ],
        ['without an upload id', owned({ upload_id: null })],
      ])('should reject operations on a video %s', async (_label, video) => {
        repo.findOne.mockResolvedValue(video);

        await expect(
          service.signUploadParts('u', 'p', [1]),
        ).rejects.toBeInstanceOf(InvalidUploadStateException);
        await expect(
          service.listUploadedParts('u', 'p'),
        ).rejects.toBeInstanceOf(InvalidUploadStateException);
        await expect(
          service.completeUpload('u', 'p', []),
        ).rejects.toBeInstanceOf(InvalidUploadStateException);
        expect(storage.presignUploadParts).not.toHaveBeenCalled();
      });
    });

    describe('signUploadParts', () => {
      it('should sign the requested parts with the part TTL', async () => {
        repo.findOne.mockResolvedValue(owned());
        storage.presignUploadParts.mockResolvedValue([
          { partNumber: 1, url: 'https://s/1' },
          { partNumber: 2, url: 'https://s/2' },
        ]);

        const result = await service.signUploadParts('u', 'p', [1, 2]);

        expect(storage.presignUploadParts).toHaveBeenCalledWith(
          'originals/video-1/source.mp4',
          'upload-1',
          [1, 2],
        );
        expect(result).toEqual({
          urls: [
            { partNumber: 1, url: 'https://s/1' },
            { partNumber: 2, url: 'https://s/2' },
          ],
          expiresIn: 3600,
        });
      });

      it.each([[[3]], [[0]], [[1, 3]]])(
        'should reject part numbers %j outside 1..part_count',
        async (numbers) => {
          repo.findOne.mockResolvedValue(owned());

          await expect(
            service.signUploadParts('u', 'p', numbers),
          ).rejects.toBeInstanceOf(InvalidPartNumberException);
          expect(storage.presignUploadParts).not.toHaveBeenCalled();
        },
      );
    });

    describe('listUploadedParts', () => {
      it('should return the part contract with the stored parts', async () => {
        repo.findOne.mockResolvedValue(owned());
        storage.listParts.mockResolvedValue([
          { partNumber: 1, etag: '"a"', size: 64 },
        ]);

        const result = await service.listUploadedParts('u', 'p');

        expect(result).toEqual({
          partSize: 67108864,
          partCount: 2,
          parts: [{ partNumber: 1, etag: '"a"', size: 64 }],
        });
      });
    });

    describe('completeUpload', () => {
      it('should finalize the multipart upload and keep the video uploading', async () => {
        repo.findOne.mockResolvedValue(owned());
        const parts = [{ partNumber: 1, etag: '"a"' }];

        const video = await service.completeUpload('u', 'p', parts);

        expect(storage.completeMultipartUpload).toHaveBeenCalledWith(
          'originals/video-1/source.mp4',
          'upload-1',
          parts,
        );
        expect(video.processing_status).toBe(VideoProcessingStatus.UPLOADING);
        expect(repo.save).not.toHaveBeenCalled();
      });

      it('should succeed again when the object already exists', async () => {
        repo.findOne.mockResolvedValue(owned());
        storage.completeMultipartUpload.mockRejectedValue(
          new InvalidUploadPartsError('NoSuchUpload'),
        );
        storage.objectExists.mockResolvedValue(true);

        const video = await service.completeUpload('u', 'p', []);

        expect(storage.objectExists).toHaveBeenCalledWith(
          'originals/video-1/source.mp4',
        );
        expect(video.processing_status).toBe(VideoProcessingStatus.UPLOADING);
      });

      it('should map a storage rejection of the parts to a domain exception', async () => {
        repo.findOne.mockResolvedValue(owned());
        storage.completeMultipartUpload.mockRejectedValue(
          new InvalidUploadPartsError('InvalidPart'),
        );
        storage.objectExists.mockResolvedValue(false);

        await expect(
          service.completeUpload('u', 'p', []),
        ).rejects.toBeInstanceOf(InvalidUploadPartsException);
      });

      it('should not hide unexpected storage errors', async () => {
        repo.findOne.mockResolvedValue(owned());
        storage.completeMultipartUpload.mockRejectedValue(new Error('network'));

        await expect(service.completeUpload('u', 'p', [])).rejects.toThrow(
          'network',
        );
      });
    });
  });

  describe('status and delivery', () => {
    const video = (overrides: Partial<Video> = {}): Partial<Video> => ({
      id: 'video-1',
      title: 'Minha "aula"',
      processing_status: VideoProcessingStatus.READY,
      original_key: 'originals/video-1/source.webm',
      playback_key: 'playback/video-1.mp4',
      thumbnail_key: 'thumbnails/video-1.jpg',
      ...overrides,
    });

    describe('getOwnedVideo', () => {
      it('should expose the public thumbnail URL once the video is ready', async () => {
        repo.findOne.mockResolvedValue(video());
        storage.publicObjectUrl.mockReturnValue(
          'http://s/thumbnails/video-1.jpg',
        );

        const result = await service.getOwnedVideo('u', 'p');

        expect(storage.publicObjectUrl).toHaveBeenCalledWith(
          'thumbnails/video-1.jpg',
        );
        expect(result.thumbnailUrl).toBe('http://s/thumbnails/video-1.jpg');
      });

      it.each([
        VideoProcessingStatus.UPLOADING,
        VideoProcessingStatus.PROCESSING,
        VideoProcessingStatus.FAILED,
      ])(
        'should have no thumbnail URL while the video is %s',
        async (status) => {
          repo.findOne.mockResolvedValue(
            video({ processing_status: status, thumbnail_key: null }),
          );

          const result = await service.getOwnedVideo('u', 'p');

          expect(result.thumbnailUrl).toBeNull();
          expect(storage.publicObjectUrl).not.toHaveBeenCalled();
        },
      );

      it('should answer not found for a missing or foreign video', async () => {
        repo.findOne.mockResolvedValue(null);

        await expect(service.getOwnedVideo('u', 'p')).rejects.toBeInstanceOf(
          VideoNotFoundException,
        );
      });
    });

    describe.each([
      ['getPlaybackUrl', (s: VideosService) => s.getPlaybackUrl('u', 'p')],
      ['getDownloadUrl', (s: VideosService) => s.getDownloadUrl('u', 'p')],
    ])('%s', (_name, call) => {
      it.each([
        VideoProcessingStatus.UPLOADING,
        VideoProcessingStatus.PROCESSING,
        VideoProcessingStatus.FAILED,
      ])('should refuse a video that is %s', async (status) => {
        repo.findOne.mockResolvedValue(video({ processing_status: status }));

        await expect(call(service)).rejects.toBeInstanceOf(
          VideoNotReadyException,
        );
        expect(storage.presignGet).not.toHaveBeenCalled();
      });

      it('should answer not found for a missing or foreign video', async () => {
        repo.findOne.mockResolvedValue(null);

        await expect(call(service)).rejects.toBeInstanceOf(
          VideoNotFoundException,
        );
      });
    });

    it('should sign the playback file and report the delivery TTL', async () => {
      repo.findOne.mockResolvedValue(video());
      storage.presignGet.mockResolvedValue('https://s/playback');

      const result = await service.getPlaybackUrl('u', 'p');

      expect(storage.presignGet).toHaveBeenCalledWith(
        'playback/video-1.mp4',
        {},
      );
      expect(result).toEqual({ url: 'https://s/playback', expiresIn: 900 });
    });

    it('should sign the original as an attachment named after a sanitized title', async () => {
      repo.findOne.mockResolvedValue(video());
      storage.presignGet.mockResolvedValue('https://s/original');

      const result = await service.getDownloadUrl('u', 'p');

      expect(storage.presignGet).toHaveBeenCalledWith(
        'originals/video-1/source.webm',
        {
          responseContentDisposition: 'attachment; filename="Minha aula.webm"',
        },
      );
      expect(result).toEqual({ url: 'https://s/original', expiresIn: 900 });
    });
  });
});
