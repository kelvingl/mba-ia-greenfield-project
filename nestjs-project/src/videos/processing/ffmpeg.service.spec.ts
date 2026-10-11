import { needsTranscode } from './ffmpeg.service';
import type { MediaProbe } from './ffmpeg.service';

const probe = (overrides: Partial<MediaProbe> = {}): MediaProbe => ({
  durationSeconds: 2,
  width: 640,
  height: 360,
  videoCodec: 'h264',
  audioCodec: 'aac',
  ...overrides,
});

describe('needsTranscode', () => {
  it.each([
    ['H.264 + AAC', probe(), false],
    ['H.264 without audio', probe({ audioCodec: null }), false],
    ['VP9 + Opus', probe({ videoCodec: 'vp9', audioCodec: 'opus' }), true],
    ['VP9 + AAC', probe({ videoCodec: 'vp9' }), true],
    ['H.264 + Opus', probe({ audioCodec: 'opus' }), true],
    ['H.264 + MP3', probe({ audioCodec: 'mp3' }), true],
  ])('should decide for %s', (_label, input, expected) => {
    expect(needsTranscode(input)).toBe(expected);
  });
});
