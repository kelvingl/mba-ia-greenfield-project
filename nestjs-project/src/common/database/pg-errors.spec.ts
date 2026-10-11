import { QueryFailedError } from 'typeorm';
import { isUniqueViolationOnColumn } from './pg-errors';

const queryFailed = (driverError: Record<string, unknown>) =>
  new QueryFailedError(
    'INSERT',
    [],
    Object.assign(new Error('x'), driverError),
  );

describe('isUniqueViolationOnColumn', () => {
  it('should match a unique violation that names the column', () => {
    const error = queryFailed({
      code: '23505',
      detail: 'Key (public_id)=(abc) already exists.',
    });
    expect(isUniqueViolationOnColumn(error, 'public_id')).toBe(true);
  });

  it('should not match a unique violation on another column', () => {
    const error = queryFailed({
      code: '23505',
      detail: 'Key (nickname)=(abc) already exists.',
    });
    expect(isUniqueViolationOnColumn(error, 'public_id')).toBe(false);
  });

  it('should not match other database errors or non-database errors', () => {
    expect(
      isUniqueViolationOnColumn(queryFailed({ code: '23503' }), 'public_id'),
    ).toBe(false);
    expect(isUniqueViolationOnColumn(new Error('boom'), 'public_id')).toBe(
      false,
    );
  });
});
