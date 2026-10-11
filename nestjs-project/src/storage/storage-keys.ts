const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ORIGINAL_KEY_PATTERN = new RegExp(
  `^originals/(${UUID})/source[^/]*$`,
  'i',
);

export const originalKey = (videoId: string, extension: string): string =>
  `originals/${videoId}/source${extension}`;

export const playbackKey = (videoId: string): string =>
  `playback/${videoId}.mp4`;

export const thumbnailKey = (videoId: string): string =>
  `thumbnails/${videoId}.jpg`;

/**
 * Extracts the video id from an object key of the `originals/` prefix.
 * Keys in S3 event notifications arrive URL-encoded, so decode first.
 */
export const parseVideoIdFromOriginalKey = (key: string): string | null => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(key.replace(/\+/g, ' '));
  } catch {
    return null;
  }
  const match = ORIGINAL_KEY_PATTERN.exec(decoded);
  return match ? match[1] : null;
};
