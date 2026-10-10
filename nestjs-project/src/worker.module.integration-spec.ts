import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { WorkerModule } from './worker.module';

describe('WorkerModule (integration)', () => {
  it('should boot as an application context without any HTTP server', async () => {
    process.env.QUEUE_PREFIX = `test-${Date.now()}-worker-module`;

    const module = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
    const app = module.createNestApplication();
    await app.init();

    // Connected to Postgres through the shared databaseConfig.
    expect(app.get(DataSource).isInitialized).toBe(true);
    // The Nest app was initialized but never started listening.
    expect((app.getHttpServer() as { listening: boolean }).listening).toBe(
      false,
    );

    await app.close();
  }, 30000);
});
