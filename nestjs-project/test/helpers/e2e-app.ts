import { INestApplication, ValidationPipe } from '@nestjs/common';
import type { App } from 'supertest/types';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { DomainExceptionFilter } from '../../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../../src/common/filters/validation-exception.filter';

export interface E2eContext {
  app: INestApplication<App>;
  dataSource: DataSource;
  throttlerStorage: ThrottlerStorageService;
}

/** Boots the real AppModule reproducing the global config of `main.ts`. */
export async function createE2eApp(): Promise<E2eContext> {
  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication<INestApplication<App>>();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(
    new DomainExceptionFilter(),
    new ValidationExceptionFilter(),
  );
  await app.init();

  return {
    app,
    dataSource: moduleFixture.get(DataSource),
    throttlerStorage:
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage),
  };
}

/**
 * Registers a user through the API, confirms the account directly in the
 * database (the confirmation e-mail flow is covered by the auth specs) and
 * logs in. Returns the access token and the user's channel id.
 */
export async function createAuthenticatedUser(
  { app, dataSource }: Pick<E2eContext, 'app' | 'dataSource'>,
  email: string,
  password = 'password123',
): Promise<{ accessToken: string; userId: string; channelId: string }> {
  const registered = await request(app.getHttpServer())
    .post('/auth/register')
    .send({ email, password })
    .expect(201);
  const userId = (registered.body as { id: string }).id;
  await dataSource.query(
    'UPDATE "users" SET "is_confirmed" = true WHERE "email" = $1',
    [email],
  );
  const login = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password })
    .expect(200);
  const accessToken = (login.body as { access_token: string }).access_token;
  const [channel] = await dataSource.query<{ id: string }[]>(
    'SELECT "id" FROM "channels" WHERE "user_id" = $1',
    [userId],
  );

  return { accessToken, userId, channelId: channel.id };
}
