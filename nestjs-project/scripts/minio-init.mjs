// One-shot storage bootstrap run by the `minio-init` Compose service.
// Idempotent: creates the bucket and makes only the `thumbnails/` prefix
// anonymously readable (per phase-03-videos/TD-01 Revision and TD-11).
// CORS (incl. ETag exposure) and the stale multipart cleanup are server-level
// MinIO settings configured on the `minio` service, because MinIO rejects
// per-bucket CORS and AbortIncompleteMultipartUpload lifecycle rules.
import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketNotificationConfigurationCommand,
  PutBucketPolicyCommand,
  S3Client,
} from '@aws-sdk/client-s3';

const { S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_BUCKET } =
  process.env;

const client = new S3Client({
  endpoint: S3_ENDPOINT,
  region: S3_REGION,
  forcePathStyle: true,
  credentials: { accessKeyId: S3_ACCESS_KEY_ID, secretAccessKey: S3_SECRET_ACCESS_KEY },
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});

async function waitForStorage(attempts = 30) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await client.send(new HeadBucketCommand({ Bucket: S3_BUCKET }));
      return true;
    } catch (err) {
      if (err.$metadata?.httpStatusCode === 404) return false;
      if (i === attempts) throw err;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

if (!(await waitForStorage())) {
  await client.send(new CreateBucketCommand({ Bucket: S3_BUCKET }));
  console.log(`bucket created: ${S3_BUCKET}`);
}

await client.send(
  new PutBucketPolicyCommand({
    Bucket: S3_BUCKET,
    Policy: JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: { AWS: ['*'] },
          Action: ['s3:GetObject'],
          Resource: [`arn:aws:s3:::${S3_BUCKET}/thumbnails/*`],
        },
      ],
    }),
  }),
);
console.log(`public-read policy applied to ${S3_BUCKET}/thumbnails/`);

// Tell the bucket to notify the webhook target (see `minio` service env) when a
// multipart upload of an original completes (TD-06 B).
await client.send(
  new PutBucketNotificationConfigurationCommand({
    Bucket: S3_BUCKET,
    NotificationConfiguration: {
      QueueConfigurations: [
        {
          QueueArn: 'arn:minio:sqs::PRIMARY:webhook',
          Events: ['s3:ObjectCreated:CompleteMultipartUpload'],
          Filter: {
            Key: { FilterRules: [{ Name: 'prefix', Value: 'originals/' }] },
          },
        },
      ],
    },
  }),
);
console.log(`notifications enabled for ${S3_BUCKET}/originals/`);
