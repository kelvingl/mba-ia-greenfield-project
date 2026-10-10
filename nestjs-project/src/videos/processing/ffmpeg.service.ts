import { Injectable } from '@nestjs/common';
import ffmpeg from 'fluent-ffmpeg';
import { PermanentMediaError } from './media.errors';

export interface MediaProbe {
  durationSeconds: number;
  width: number;
  height: number;
  videoCodec: string;
  /** `null` when the file has no audio stream. */
  audioCodec: string | null;
}

/** Thumbnail width; the height follows the aspect ratio (kept even). */
const THUMBNAIL_WIDTH = 1280;
/** Where in the video the thumbnail window starts (phase-03-videos/TD-13). */
const THUMBNAIL_OFFSET_RATIO = 0.1;
const FASTSTART = ['-movflags', '+faststart'];

/** ffprobe messages that say the bytes are not media, as opposed to I/O trouble. */
const UNREADABLE_MEDIA =
  /invalid data found|moov atom not found|could not find codec parameters/i;

/** Only H.264 video with AAC (or no) audio can be copied into the playback MP4. */
export function needsTranscode(probe: MediaProbe): boolean {
  const copyable =
    probe.videoCodec === 'h264' &&
    (probe.audioCodec === null || probe.audioCodec === 'aac');
  return !copyable;
}

/**
 * The only place that talks to FFmpeg/ffprobe (phase-03-videos/TD-08 Revision).
 * Callers get typed results and `PermanentMediaError` for unprocessable input,
 * never wrapper types.
 */
@Injectable()
export class FfmpegService {
  /** `input` is a local path or an HTTP(S) URL (read with Range requests). */
  probe(input: string): Promise<MediaProbe> {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(input, (error: Error | null, data) => {
        if (error) {
          reject(
            UNREADABLE_MEDIA.test(error.message)
              ? new PermanentMediaError(error.message)
              : error,
          );
          return;
        }
        const video = data.streams.find((s) => s.codec_type === 'video');
        if (!video || !video.codec_name) {
          reject(new PermanentMediaError('The file has no video stream'));
          return;
        }
        const audio = data.streams.find((s) => s.codec_type === 'audio');
        resolve({
          durationSeconds: Number(data.format.duration),
          width: video.width ?? 0,
          height: video.height ?? 0,
          videoCodec: video.codec_name,
          audioCodec: audio?.codec_name ?? null,
        });
      });
    });
  }

  /**
   * A normal output command, not `screenshots()`, which does not combine with
   * filters: seek, pick a representative frame in a short window, scale.
   */
  extractThumbnail(
    input: string,
    durationSeconds: number,
    outPath: string,
  ): Promise<void> {
    // Stay inside short videos: never seek into the last second.
    const offset = Math.min(
      durationSeconds * THUMBNAIL_OFFSET_RATIO,
      Math.max(durationSeconds - 1, 0),
    );
    return this.run(
      ffmpeg(input)
        .seekInput(offset)
        .videoFilters(['thumbnail', `scale=${THUMBNAIL_WIDTH}:-2`])
        .frames(1)
        .format('image2')
        .output(outPath),
    );
  }

  /** Always writes a seekable file: faststart cannot be done through a pipe. */
  normalizeForPlayback(
    inputPath: string,
    probe: MediaProbe,
    outPath: string,
  ): Promise<void> {
    const codecs = needsTranscode(probe)
      ? ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac']
      : ['-c', 'copy'];
    return this.run(
      ffmpeg(inputPath)
        .outputOptions([...codecs, ...FASTSTART])
        .format('mp4')
        .output(outPath),
    );
  }

  private run(command: ffmpeg.FfmpegCommand): Promise<void> {
    return new Promise((resolve, reject) => {
      command
        .on('error', reject)
        .on('end', () => resolve())
        .run();
    });
  }
}
