import { createHash, timingSafeEqual } from 'node:crypto';
import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InvalidWebhookTokenException } from '../../common/exceptions/domain.exception';
import storageConfig from '../../config/storage.config';

const BEARER_PREFIX = 'Bearer ';

const digest = (value: string): Buffer =>
  createHash('sha256').update(value).digest();

/**
 * Authenticates the storage event webhook with the shared token from env
 * (phase-03-videos/TD-06 Revision). Compared in constant time.
 */
@Injectable()
export class StorageWebhookTokenGuard implements CanActivate {
  constructor(
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const { headers } = context
      .switchToHttp()
      .getRequest<{ headers: { authorization?: string } }>();
    const header = headers.authorization ?? '';
    const token = header.startsWith(BEARER_PREFIX)
      ? header.slice(BEARER_PREFIX.length)
      : '';

    // Hash both sides so the comparison is constant time for any length.
    if (!timingSafeEqual(digest(token), digest(this.config.webhookToken))) {
      throw new InvalidWebhookTokenException();
    }
    return true;
  }
}
