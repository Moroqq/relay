/**
 * Database access.
 *
 * Postgres hands back NUMERIC and BIGINT as strings, because neither fits a
 * JavaScript number safely. We convert them to `bigint` explicitly at the edge
 * rather than installing a global type parser, so that every place a number
 * becomes money is visible in the code and greppable.
 */

import pg from 'pg';

export type { PoolClient } from 'pg';

let pool: pg.Pool | null = null;

export function getPool(connectionString?: string): pg.Pool {
  if (pool !== null) return pool;

  const url = connectionString ?? process.env.DATABASE_URL;
  if (url === undefined || url === '') {
    throw new Error('DATABASE_URL is not set');
  }

  pool = new pg.Pool({
    connectionString: url,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  // A pool error is emitted for idle clients dropped by the server. Without a
  // listener, Node treats it as an unhandled 'error' event and exits.
  pool.on('error', (error) => {
    console.error('[db] idle client error:', error.message);
  });

  return pool;
}

export async function closePool(): Promise<void> {
  if (pool === null) return;
  const closing = pool;
  pool = null;
  await closing.end();
}

/**
 * Run a body inside a transaction, committing on success and rolling back on
 * any throw. Nested calls are not supported deliberately — a payment write
 * that thinks it is atomic but is actually a savepoint inside someone else's
 * transaction is exactly the kind of surprise that loses money.
 */
export async function inTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
  connectionString?: string,
): Promise<T> {
  const client = await getPool(connectionString).connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The connection is already broken; the original error is the useful one.
    }
    throw error;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Conversions at the edge
// ---------------------------------------------------------------------------

/** A NUMERIC or BIGINT column that cannot be null. */
export function toBigInt(value: unknown): bigint {
  if (typeof value === 'string') return BigInt(value);
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  throw new TypeError(`Expected a numeric column value, got ${typeof value}: ${String(value)}`);
}

/** The same, for a nullable column. */
export function toBigIntOrNull(value: unknown): bigint | null {
  return value === null || value === undefined ? null : toBigInt(value);
}

/** Postgres unique-violation. Used to turn a race into a retry rather than a 500. */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; constraint?: unknown };
  if (candidate.code !== '23505') return false;
  return constraint === undefined || candidate.constraint === constraint;
}
