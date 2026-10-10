import { generatePublicId, PUBLIC_ID_PATTERN } from './public-id';

describe('generatePublicId', () => {
  it('should generate an 11-char base64url id without padding', () => {
    const id = generatePublicId();

    expect(id).toHaveLength(11);
    expect(id).toMatch(PUBLIC_ID_PATTERN);
    expect(id).not.toContain('=');
  });

  it('should not repeat across 10 000 generations', () => {
    const ids = new Set(Array.from({ length: 10_000 }, generatePublicId));

    expect(ids.size).toBe(10_000);
  });
});
