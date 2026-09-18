/**
 * Heartbeats from background services, for the console to show.
 */

import { getPool } from './pool.ts';

export interface ServiceStatus {
  readonly service: string;
  readonly state: string;
  readonly detail: Record<string, unknown>;
  /** When the service entered its current state. */
  readonly since: Date;
  /** When it last reported, whatever the state. */
  readonly updatedAt: Date;
}

/** Report the current state. `since` moves only when the state changes. */
export async function reportServiceStatus(service: string, state: string, detail: Record<string, unknown> = {}): Promise<void> {
  await getPool().query(
    `INSERT INTO service_status (service, state, detail) VALUES ($1, $2, $3)
     ON CONFLICT (service) DO UPDATE
        SET state = EXCLUDED.state,
            detail = EXCLUDED.detail,
            since = CASE WHEN service_status.state = EXCLUDED.state THEN service_status.since ELSE now() END,
            updated_at = now()`,
    [service, state, JSON.stringify(detail)],
  );
}

export async function readServiceStatus(service: string): Promise<ServiceStatus | null> {
  const { rows } = await getPool().query(
    'SELECT service, state, detail, since, updated_at FROM service_status WHERE service = $1',
    [service],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return Object.freeze({
    service: row['service'] as string,
    state: row['state'] as string,
    detail: row['detail'] as Record<string, unknown>,
    since: row['since'] as Date,
    updatedAt: row['updated_at'] as Date,
  });
}
