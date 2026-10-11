import { Test } from '@nestjs/testing';
import { VideoProcessor } from './videos/processing/video.processor';
import { AppModule } from './app.module';
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

  it('should own the video processor, which the API module must not register', async () => {
    process.env.QUEUE_PREFIX = `test-${Date.now()}-worker-module-owner`;

    const worker = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
    const api = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    expect(worker.get(VideoProcessor, { strict: false })).toBeInstanceOf(
      VideoProcessor,
    );
    expect(() => api.get(VideoProcessor, { strict: false })).toThrow();

    await worker.close();
    await api.close();
  }, 30000);
});
