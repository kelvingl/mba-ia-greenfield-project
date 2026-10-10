import {
  originalKey,
  parseVideoIdFromOriginalKey,
  playbackKey,
  thumbnailKey,
} from './storage-keys';

const videoId = '3f6c1f0e-6d52-4a53-9f43-0a1d3f2d7b11';

describe('storage keys', () => {
  it('should build the original, playback and thumbnail keys', () => {
    expect(originalKey(videoId, '.mp4')).toBe(
      `originals/${videoId}/source.mp4`,
    );
    expect(playbackKey(videoId)).toBe(`playback/${videoId}.mp4`);
    expect(thumbnailKey(videoId)).toBe(`thumbnails/${videoId}.jpg`);
  });

  describe('parseVideoIdFromOriginalKey', () => {
    it('should extract the video id from a valid original key', () => {
      expect(
        parseVideoIdFromOriginalKey(`originals/${videoId}/source.mkv`),
      ).toBe(videoId);
    });

    it('should accept a URL-encoded key as sent in S3 event notifications', () => {
      expect(
        parseVideoIdFromOriginalKey(`originals%2F${videoId}%2Fsource.mp4`),
      ).toBe(videoId);
    });

    it.each([
      `playback/${videoId}.mp4`,
      `thumbnails/${videoId}.jpg`,
      'originals/not-a-uuid/source.mp4',
      `originals/${videoId}`,
      '',
    ])('should return null for %s', (key) => {
      expect(parseVideoIdFromOriginalKey(key)).toBeNull();
    });
  });
});
