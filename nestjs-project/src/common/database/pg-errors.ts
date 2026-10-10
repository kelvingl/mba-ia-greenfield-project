import { QueryFailedError } from 'typeorm';

const PG_UNIQUE_VIOLATION = '23505';

/** True for a PostgreSQL unique violation whose detail names the given column. */
export function isUniqueViolationOnColumn(
  error: unknown,
  column: string,
): boolean {
  if (!(error instanceof QueryFailedError)) return false;
  const { code, detail } = error as QueryFailedError & {
    code?: string;
    detail?: string;
  };
  return (
    code === PG_UNIQUE_VIOLATION &&
    typeof detail === 'string' &&
    detail.includes(`(${column})`)
  );
}
