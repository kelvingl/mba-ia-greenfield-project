/**
 * Polls `predicate` until it is true. Use instead of fixed sleeps when an
 * outcome is produced asynchronously (e.g. a queue worker event handler).
 */
export async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  { timeoutMs = 15_000, intervalMs = 50 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) {
      throw new Error(`waitFor: condition not met within ${timeoutMs} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
