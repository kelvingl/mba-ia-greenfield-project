import 'dotenv/config';
import Redis from 'ioredis';

/**
 * Specs isolate BullMQ with a unique `test-*` QUEUE_PREFIX and cannot always
 * clean up after a crash or a closed scheduler. Runs once after the whole
 * suite and deletes only keys under that prefix (never the `bull` one).
 */
export default async function globalTeardown(): Promise<void> {
  const redis = new Redis({
    host: process.env.REDIS_HOST,
    port: parseInt(process.env.REDIS_PORT as string, 10),
  });
  try {
    const stream = redis.scanStream({ match: 'test-*', count: 500 });
    for await (const keys of stream as AsyncIterable<string[]>) {
      if (keys.length > 0) await redis.unlink(...keys);
    }
  } finally {
    redis.disconnect();
  }
}
