import { processingJobOptions } from './queue.constants';

describe('processingJobOptions', () => {
  it('should retry 3 times with exponential backoff using the given delay', () => {
    expect(processingJobOptions(250)).toEqual({
      attempts: 3,
      backoff: { type: 'exponential', delay: 250 },
    });
  });
});
