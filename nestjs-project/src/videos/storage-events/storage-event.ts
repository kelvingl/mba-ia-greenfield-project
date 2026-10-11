import { BadRequestException } from '@nestjs/common';

/** The only S3 event the API reacts to: a finished multipart upload. */
const MULTIPART_COMPLETED_EVENT = 'ObjectCreated:CompleteMultipartUpload';

export interface ObjectCreatedRecord {
  /** Object key exactly as notified (URL-encoded). */
  key: string;
  /** Object size in bytes as notified. */
  size: number;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const notAnEvent = () =>
  new BadRequestException('Body is not an S3 event notification');

/**
 * Extracts the multipart-completed objects from an S3 event notification
 * (MinIO webhook / S3 → SQS payload). Events of other kinds are ignored; a body
 * that is not a notification at all is rejected.
 */
export function parseObjectCreatedRecords(
  body: unknown,
): ObjectCreatedRecord[] {
  if (!isObject(body) || !Array.isArray(body.Records)) throw notAnEvent();

  const records: ObjectCreatedRecord[] = [];
  for (const raw of body.Records as unknown[]) {
    if (!isObject(raw)) throw notAnEvent();
    const eventName = raw.eventName ?? body.EventName;
    if (typeof eventName !== 'string') throw notAnEvent();
    if (!eventName.endsWith(MULTIPART_COMPLETED_EVENT)) continue;

    const object = isObject(raw.s3) ? raw.s3.object : undefined;
    if (
      !isObject(object) ||
      typeof object.key !== 'string' ||
      typeof object.size !== 'number'
    ) {
      throw notAnEvent();
    }
    records.push({ key: object.key, size: object.size });
  }
  return records;
}
