import { ExecutionContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import storageConfig from '../../config/storage.config';
import { InvalidWebhookTokenException } from '../../common/exceptions/domain.exception';
import { StorageWebhookTokenGuard } from './storage-webhook-token.guard';

const contextWith = (authorization?: string): ExecutionContext =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({ headers: { authorization } }),
    }),
  }) as unknown as ExecutionContext;

describe('StorageWebhookTokenGuard', () => {
  let guard: StorageWebhookTokenGuard;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        StorageWebhookTokenGuard,
        {
          provide: storageConfig.KEY,
          useValue: { webhookToken: 'secret-token' },
        },
      ],
    }).compile();
    guard = module.get(StorageWebhookTokenGuard);
  });

  it('should let the request through with the shared token', () => {
    expect(guard.canActivate(contextWith('Bearer secret-token'))).toBe(true);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['wrong', 'Bearer wrong-token'],
    ['without the Bearer scheme', 'secret-token'],
    ['longer than the token', 'Bearer secret-token-and-more'],
    ['shorter than the token', 'Bearer secret'],
  ])('should reject a %s token', (_label, header) => {
    expect(() => guard.canActivate(contextWith(header))).toThrow(
      InvalidWebhookTokenException,
    );
  });
});
