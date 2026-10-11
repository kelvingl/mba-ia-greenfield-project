import { S3Client } from '@aws-sdk/client-s3';
import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { INTERNAL_S3_CLIENT, PUBLIC_S3_CLIENT } from './storage.constants';
import { StorageService } from './storage.service';

const createClient = (
  cfg: ConfigType<typeof storageConfig>,
  endpoint: string,
): S3Client =>
  new S3Client({
    endpoint,
    region: cfg.region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    },
    // Newer SDK defaults add CRC32 checksums that S3-compatible servers may reject.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });

@Module({
  providers: [
    {
      provide: INTERNAL_S3_CLIENT,
      inject: [storageConfig.KEY],
      useFactory: (cfg: ConfigType<typeof storageConfig>) =>
        createClient(cfg, cfg.endpoint),
    },
    {
      provide: PUBLIC_S3_CLIENT,
      inject: [storageConfig.KEY],
      useFactory: (cfg: ConfigType<typeof storageConfig>) =>
        createClient(cfg, cfg.publicEndpoint),
    },
    StorageService,
  ],
  exports: [StorageService],
})
export class StorageModule {}
