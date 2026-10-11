import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { INTERNAL_S3_CLIENT, PUBLIC_S3_CLIENT } from './storage.constants';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

describe('StorageModule', () => {
  it('should compile and provide the service and both S3 clients', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();

    expect(module.get(StorageService)).toBeInstanceOf(StorageService);
    expect(module.get(INTERNAL_S3_CLIENT, { strict: false })).toBeDefined();
    expect(module.get(PUBLIC_S3_CLIENT, { strict: false })).toBeDefined();
    await module.close();
  });

  it('should sign against the public endpoint and use the internal one for calls', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();

    const internal = module.get<import('@aws-sdk/client-s3').S3Client>(
      INTERNAL_S3_CLIENT,
      { strict: false },
    );
    const pub = module.get<import('@aws-sdk/client-s3').S3Client>(
      PUBLIC_S3_CLIENT,
      { strict: false },
    );
    const host = async (c: typeof internal) =>
      (await c.config.endpoint?.())?.hostname;

    expect(await host(internal)).toBe(
      new URL(process.env.S3_ENDPOINT!).hostname,
    );
    expect(await host(pub)).toBe(
      new URL(process.env.S3_PUBLIC_ENDPOINT!).hostname,
    );
    await module.close();
  });
});
