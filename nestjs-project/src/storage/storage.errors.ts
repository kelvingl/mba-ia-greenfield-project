/** The storage rejected the list of parts sent to CompleteMultipartUpload. */
export class InvalidUploadPartsError extends Error {
  constructor(public readonly reason: string) {
    super(`Invalid multipart upload parts: ${reason}`);
    this.name = 'InvalidUploadPartsError';
  }
}
