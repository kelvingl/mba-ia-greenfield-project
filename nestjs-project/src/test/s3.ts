import {
  AbortMultipartUploadCommand,
  CreateBucketCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  ListMultipartUploadsCommand,
  paginateListObjectsV2,
  PutBucketPolicyCommand,
  S3Client,
} from '@aws-sdk/client-s3';

/** Dedicated bucket so tests never touch the development bucket. */
export const TEST_BUCKET =
  process.env.S3_TEST_BUCKET ?? `${process.env.S3_BUCKET ?? 'streamtube'}-test`;

/**
 * Makes the app config (`storageConfig`) point at the test bucket.
 * Call at the top of a spec, before the Nest module is created.
 */
export function useTestBucket(): void {
  process.env.S3_BUCKET = TEST_BUCKET;
}

export const internalS3Client = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID as string,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY as string,
  },
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});

/** Creates the test bucket (with the thumbnails/ public-read policy) if missing. */
export async function ensureTestBucket(): Promise<void> {
  try {
    await internalS3Client.send(new HeadBucketCommand({ Bucket: TEST_BUCKET }));
    return;
  } catch (error) {
    if (
      (error as { $metadata?: { httpStatusCode?: number } }).$metadata
        ?.httpStatusCode !== 404
    ) {
      throw error;
    }
  }
  await internalS3Client.send(new CreateBucketCommand({ Bucket: TEST_BUCKET }));
  await internalS3Client.send(
    new PutBucketPolicyCommand({
      Bucket: TEST_BUCKET,
      Policy: JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { AWS: ['*'] },
            Action: ['s3:GetObject'],
            Resource: [`arn:aws:s3:::${TEST_BUCKET}/thumbnails/*`],
          },
        ],
      }),
    }),
  );
}

/** Deletes every object and aborts every pending multipart upload. */
export async function emptyTestBucket(): Promise<void> {
  await ensureTestBucket();

  for await (const page of paginateListObjectsV2(
    { client: internalS3Client },
    { Bucket: TEST_BUCKET },
  )) {
    for (const object of page.Contents ?? []) {
      await internalS3Client.send(
        new DeleteObjectCommand({ Bucket: TEST_BUCKET, Key: object.Key }),
      );
    }
  }

  const { Uploads } = await internalS3Client.send(
    new ListMultipartUploadsCommand({ Bucket: TEST_BUCKET }),
  );
  for (const upload of Uploads ?? []) {
    await internalS3Client.send(
      new AbortMultipartUploadCommand({
        Bucket: TEST_BUCKET,
        Key: upload.Key,
        UploadId: upload.UploadId,
      }),
    );
  }
}
