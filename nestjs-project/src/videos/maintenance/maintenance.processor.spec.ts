import type { Job } from 'bullmq';
import { MaintenanceProcessor } from './maintenance.processor';
import { StaleUploadSweepService } from './stale-upload-sweep.service';

describe('MaintenanceProcessor', () => {
  const sweep = { markStaleUploads: jest.fn() };
  const processor = new MaintenanceProcessor(
    sweep as unknown as StaleUploadSweepService,
  );
  const job = (name: string) => ({ name }) as Job;

  beforeEach(() => {
    jest.resetAllMocks();
    sweep.markStaleUploads.mockResolvedValue(0);
  });

  it('should run the sweep with the current time for the sweep job', async () => {
    const before = Date.now();

    await processor.process(job('sweep-stale-uploads'));

    expect(sweep.markStaleUploads).toHaveBeenCalledTimes(1);
    const now = (sweep.markStaleUploads.mock.calls[0] as [Date])[0];
    expect(now.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('should ignore a job it does not know', async () => {
    await processor.process(job('something-else'));

    expect(sweep.markStaleUploads).not.toHaveBeenCalled();
  });
});
