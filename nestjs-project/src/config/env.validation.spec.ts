import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
};

const mediaEnv = {
  S3_ENDPOINT: 'http://minio:9000',
  S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
  S3_REGION: 'us-east-1',
  S3_ACCESS_KEY_ID: 'minioadmin',
  S3_SECRET_ACCESS_KEY: 'minioadmin',
  S3_BUCKET: 'streamtube',
  STORAGE_WEBHOOK_TOKEN: 'webhook-token',
  REDIS_HOST: 'redis',
  REDIS_PORT: '6379',
};

const validate = (env: Record<string, string>) =>
  envValidationSchema.validate(env, {
    allowUnknown: true,
    abortEarly: false,
  }) as { value: Record<string, unknown>; error?: Error };

describe('envValidationSchema — storage and queue keys', () => {
  it('should accept a complete environment', () => {
    const { error } = validate({ ...requiredEnv, ...mediaEnv });
    expect(error).toBeUndefined();
  });

  it.each(Object.keys(mediaEnv))('should reject a missing %s', (key) => {
    const env: Record<string, string> = { ...requiredEnv, ...mediaEnv };
    delete env[key];

    const { error } = validate(env);

    expect(error).toBeDefined();
    expect(error!.message).toContain(key);
  });

  it('should apply defaults to the optional keys', () => {
    const { value, error } = validate({ ...requiredEnv, ...mediaEnv });

    expect(error).toBeUndefined();
    expect(value.S3_DELIVERY_URL_TTL_SECONDS).toBe(900);
    expect(value.VIDEO_PROCESSING_BACKOFF_MS).toBe(5000);
  });

  it('should reject a non-URI S3_ENDPOINT', () => {
    const { error } = validate({
      ...requiredEnv,
      ...mediaEnv,
      S3_ENDPOINT: 'not a url',
    });
    expect(error!.message).toContain('S3_ENDPOINT');
  });
});
