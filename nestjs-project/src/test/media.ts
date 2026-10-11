import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const FIXTURE_WIDTH = 640;
export const FIXTURE_HEIGHT = 360;
export const FIXTURE_DURATION_SECONDS = 2;

export interface MediaFixtures {
  dir: string;
  /** H.264/AAC MP4 written without faststart (moov after mdat). */
  mp4: string;
  /** H.264 MP4 with no audio stream. */
  mp4NoAudio: string;
  /** VP9/Opus WebM: needs a transcode to reach the playback format. */
  webm: string;
  /** Audio-only file: a valid container without a video stream. */
  audioOnly: string;
  /** Random bytes: not media at all. */
  garbage: string;
}

const video = `testsrc=size=${FIXTURE_WIDTH}x${FIXTURE_HEIGHT}:rate=25:duration=${FIXTURE_DURATION_SECONDS}`;
const audio = `sine=frequency=440:duration=${FIXTURE_DURATION_SECONDS}`;

const ffmpeg = (args: string[]) =>
  run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);

/**
 * Generates the media fixtures with the container's own FFmpeg, so no binary
 * is committed. Call `removeMediaFixtures` when done.
 */
export async function createMediaFixtures(): Promise<MediaFixtures> {
  const dir = await mkdtemp(join(tmpdir(), 'media-fixtures-'));
  const fixtures: MediaFixtures = {
    dir,
    mp4: join(dir, 'sample.mp4'),
    mp4NoAudio: join(dir, 'silent.mp4'),
    webm: join(dir, 'sample.webm'),
    audioOnly: join(dir, 'audio.m4a'),
    garbage: join(dir, 'garbage.mp4'),
  };

  await Promise.all([
    ffmpeg([
      ...['-f', 'lavfi', '-i', video, '-f', 'lavfi', '-i', audio],
      ...['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac'],
      fixtures.mp4,
    ]),
    ffmpeg([
      ...['-f', 'lavfi', '-i', video],
      ...['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an'],
      fixtures.mp4NoAudio,
    ]),
    ffmpeg([
      ...['-f', 'lavfi', '-i', video, '-f', 'lavfi', '-i', audio],
      ...['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8'],
      ...['-c:a', 'libopus'],
      fixtures.webm,
    ]),
    ffmpeg([
      ...['-f', 'lavfi', '-i', audio],
      ...['-c:a', 'aac'],
      fixtures.audioOnly,
    ]),
    writeFile(fixtures.garbage, randomBytes(64 * 1024)),
  ]);
  return fixtures;
}

export async function removeMediaFixtures(
  fixtures: MediaFixtures,
): Promise<void> {
  await rm(fixtures.dir, { recursive: true, force: true });
}

/** Names of the top-level ISO BMFF boxes of a file, in file order (e.g. ftyp, moov, mdat). */
export async function topLevelBoxes(path: string): Promise<string[]> {
  const file = await open(path, 'r');
  try {
    const { size } = await file.stat();
    const boxes: string[] = [];
    let offset = 0;
    while (offset + 8 <= size) {
      const header = Buffer.alloc(16);
      await file.read(header, 0, 16, offset);
      let boxSize = header.readUInt32BE(0);
      boxes.push(header.toString('latin1', 4, 8));
      if (boxSize === 1) boxSize = Number(header.readBigUInt64BE(8));
      else if (boxSize === 0) boxSize = size - offset;
      if (boxSize < 8) break;
      offset += boxSize;
    }
    return boxes;
  } finally {
    await file.close();
  }
}

/** Width and height of a JPEG, read from its SOF marker. */
export async function jpegSize(
  path: string,
): Promise<{ width: number; height: number }> {
  const file = await open(path, 'r');
  try {
    const { size } = await file.stat();
    const data = Buffer.alloc(size);
    await file.read(data, 0, size, 0);
    if (data.readUInt16BE(0) !== 0xffd8) throw new Error('not a JPEG');
    let offset = 2;
    while (offset + 9 < size) {
      if (data[offset] !== 0xff) throw new Error('corrupt JPEG');
      const marker = data[offset + 1];
      if (marker >= 0xc0 && marker <= 0xc3) {
        return {
          height: data.readUInt16BE(offset + 5),
          width: data.readUInt16BE(offset + 7),
        };
      }
      offset += 2 + data.readUInt16BE(offset + 2);
    }
    throw new Error('JPEG without SOF marker');
  } finally {
    await file.close();
  }
}
