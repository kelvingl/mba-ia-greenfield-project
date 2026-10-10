import { registerAs } from '@nestjs/config';

export default registerAs('queue', () => ({
  redisHost: process.env.REDIS_HOST as string,
  redisPort: parseInt(process.env.REDIS_PORT as string, 10),
  // Isolates BullMQ keys; tests set a unique value so they never share jobs
  // with the worker running in the Compose stack.
  prefix: process.env.QUEUE_PREFIX || 'bull',
  processingBackoffDelayMs: parseInt(
    process.env.VIDEO_PROCESSING_BACKOFF_MS || '5000',
    10,
  ),
}));
