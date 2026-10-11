/**
 * The input is not processable media (unreadable container, no video stream).
 * Retrying cannot help, so the processor fails the video without retries
 * (phase-03-videos/TD-15).
 */
export class PermanentMediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentMediaError';
  }
}
