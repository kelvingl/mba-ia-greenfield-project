import { BadRequestException } from '@nestjs/common';
import { parseObjectCreatedRecords } from './storage-event';

const event = (overrides: Record<string, unknown> = {}) => ({
  EventName: 's3:ObjectCreated:CompleteMultipartUpload',
  Key: 'bucket/originals/id/source.mp4',
  Records: [
    {
      eventName: 's3:ObjectCreated:CompleteMultipartUpload',
      s3: {
        bucket: { name: 'bucket' },
        object: { key: 'originals%2Fid%2Fsource.mp4', size: 1048576 },
      },
    },
  ],
  ...overrides,
});

describe('parseObjectCreatedRecords', () => {
  it('should return the key and size of each multipart-completed object', () => {
    expect(parseObjectCreatedRecords(event())).toEqual([
      { key: 'originals%2Fid%2Fsource.mp4', size: 1048576 },
    ]);
  });

  it.each(['s3:ObjectCreated:Put', 's3:ObjectRemoved:Delete'])(
    'should ignore the %s event',
    (name) => {
      expect(
        parseObjectCreatedRecords(
          event({
            EventName: name,
            Records: [
              { eventName: name, s3: { object: { key: 'k', size: 1 } } },
            ],
          }),
        ),
      ).toEqual([]);
    },
  );

  it.each([null, 'text', 42, [], {}, { Records: 'nope' }, { Records: [{}] }])(
    'should reject a body that is not an S3 event: %j',
    (body) => {
      expect(() => parseObjectCreatedRecords(body)).toThrow(
        BadRequestException,
      );
    },
  );
});
