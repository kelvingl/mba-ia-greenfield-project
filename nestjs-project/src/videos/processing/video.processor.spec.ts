import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Job, UnrecoverableError } from 'bullmq';
import queueConfig from '../../config/queue.config';
import { StorageService } from '../../storage/storage.service';
import { Video } from '../entities/video.entity';
import { FAILURE_REASONS, VideoProcessingStatus } from '../videos.constants';
import { FfmpegService } from './ffmpeg.service';
import { PermanentMediaError } from './media.errors';
import { VideoProcessor } from './video.processor';

describe('VideoProcessor', () => {
  const repo = { findOneBy: jest.fn(), update: jest.fn() };
  const ffmpeg = {
    probe: jest.fn(),
    extractThumbnail: jest.fn(),
    normalizeForPlayback: jest.fn(),
  };
  const storage = {
    presignInternalGet: jest.fn(),
    downloadObjectToFile: jest.fn(),
    putObjectFromFile: jest.fn(),
  };
  let processor: VideoProcessor;

  const jobFor = (videoId = 'video-1', attemptsMade = 0) =>
    ({
      id: videoId,
      data: { videoId },
      attemptsMade,
      opts: { attempts: 3 },
    }) as unknown as Job<{ videoId: string }>;

  beforeEach(async () => {
    jest.resetAllMocks();
    repo.findOneBy.mockResolvedValue({
      id: 'video-1',
      processing_status: VideoProcessingStatus.PROCESSING,
      original_key: 'originals/video-1/source.mp4',
    });
    storage.presignInternalGet.mockResolvedValue('http://minio/original');
    repo.update.mockResolvedValue({ affected: 1 });

    const module = await Test.createTestingModule({
      providers: [
        VideoProcessor,
        { provide: getRepositoryToken(Video), useValue: repo },
        { provide: FfmpegService, useValue: ffmpeg },
        { provide: StorageService, useValue: storage },
        {
          provide: queueConfig.KEY,
          useValue: { processingTmpDir: '/tmp' },
        },
      ],
    }).compile();
    processor = module.get(VideoProcessor);
  });

  describe('process', () => {
    it('should turn an unprocessable file into an UnrecoverableError', async () => {
      ffmpeg.probe.mockRejectedValue(new PermanentMediaError('no video'));

      const result = processor.process(jobFor());

      await expect(result).rejects.toBeInstanceOf(UnrecoverableError);
      await expect(result).rejects.toThrow(FAILURE_REASONS.NOT_A_VIDEO);
    });

    it('should rethrow a transient error untouched so the queue retries', async () => {
      const failure = new Error('ECONNRESET');
      ffmpeg.probe.mockRejectedValue(failure);

      const error = await processor.process(jobFor()).catch((e: unknown) => e);

      expect(error).toBe(failure);
      expect(error).not.toBeInstanceOf(UnrecoverableError);
    });

    it.each([
      VideoProcessingStatus.READY,
      VideoProcessingStatus.FAILED,
      VideoProcessingStatus.UPLOADING,
    ])('should do nothing for a video that is %s', async (status) => {
      repo.findOneBy.mockResolvedValue({
        id: 'video-1',
        processing_status: status,
      });

      await processor.process(jobFor());

      expect(ffmpeg.probe).not.toHaveBeenCalled();
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('should do nothing for an unknown video', async () => {
      repo.findOneBy.mockResolvedValue(null);

      await processor.process(jobFor());

      expect(ffmpeg.probe).not.toHaveBeenCalled();
    });
  });

  describe('onFailed', () => {
    it('should mark a permanent failure as not_a_video at once', async () => {
      await processor.onFailed(
        jobFor('video-1', 1),
        new UnrecoverableError('not_a_video'),
      );

      expect(repo.update).toHaveBeenCalledWith(
        { id: 'video-1', processing_status: VideoProcessingStatus.PROCESSING },
        {
          processing_status: VideoProcessingStatus.FAILED,
          failure_reason: FAILURE_REASONS.NOT_A_VIDEO,
        },
      );
    });

    it('should mark processing_failed when the last attempt is exhausted', async () => {
      await processor.onFailed(jobFor('video-1', 3), new Error('ECONNRESET'));

      expect(repo.update).toHaveBeenCalledWith(
        { id: 'video-1', processing_status: VideoProcessingStatus.PROCESSING },
        {
          processing_status: VideoProcessingStatus.FAILED,
          failure_reason: FAILURE_REASONS.PROCESSING_FAILED,
        },
      );
    });

    it('should leave the video processing while attempts remain', async () => {
      await processor.onFailed(jobFor('video-1', 1), new Error('ECONNRESET'));
      await processor.onFailed(jobFor('video-1', 2), new Error('ECONNRESET'));

      expect(repo.update).not.toHaveBeenCalled();
    });

    it('should ignore a failure without a job', async () => {
      await processor.onFailed(undefined, new Error('stalled'));

      expect(repo.update).not.toHaveBeenCalled();
    });
  });
});
