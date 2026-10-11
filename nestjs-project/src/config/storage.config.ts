import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  endpoint: process.env.S3_ENDPOINT as string,
  publicEndpoint: process.env.S3_PUBLIC_ENDPOINT as string,
  region: process.env.S3_REGION as string,
  accessKeyId: process.env.S3_ACCESS_KEY_ID as string,
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY as string,
  bucket: process.env.S3_BUCKET as string,
  partUrlTtlSeconds: 3600,
  deliveryUrlTtlSeconds: parseInt(
    process.env.S3_DELIVERY_URL_TTL_SECONDS || '900',
    10,
  ),
  uploadPartSizeBytes: parseInt(
    process.env.S3_UPLOAD_PART_SIZE_BYTES || String(64 * 1024 * 1024),
    10,
  ),
  webhookToken: process.env.STORAGE_WEBHOOK_TOKEN as string,
}));
