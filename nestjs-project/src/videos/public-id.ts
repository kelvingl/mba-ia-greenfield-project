import { randomBytes } from 'node:crypto';

export const PUBLIC_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

/**
 * Short, unguessable public identifier for the video URL: 8 random bytes
 * (~64 bits) as base64url, which is exactly 11 characters without padding
 * (phase-03-videos/TD-12). Uniqueness is enforced by the database.
 */
export const generatePublicId = (): string =>
  randomBytes(8).toString('base64url');
