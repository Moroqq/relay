/**
 * Projects and their API credentials.
 */

import type { PoolClient } from 'pg';
import { hashApiKey } from '@relay/core';

import { getPool, toBigInt } from './pool.ts';

export interface ProjectRecord {
  readonly id: string;
  readonly merchantId: string;
  readonly name: string;
  readonly status: 'active' | 'paused' | 'archived';
  readonly payoutAddress: string | null;
  readonly feeRateBps: bigint;
  readonly feeFlatUnits: bigint;
  readonly toleranceUnderBps: bigint;
  readonly toleranceUnderFloor: bigint;
  readonly toleranceOverBps: bigint;
  readonly toleranceOverFloor: bigint;
  readonly webhookUrl: string | null;
  readonly webhookSecret: string | null;
}

const PROJECT_COLUMNS = `
  id, merchant_id, name, status, payout_address,
  fee_rate_bps, fee_flat_units,
  tolerance_under_bps, tolerance_under_floor,
  tolerance_over_bps, tolerance_over_floor,
  webhook_url, webhook_secret
`;

function mapProject(row: Record<string, unknown>): ProjectRecord {
  return Object.freeze({
    id: row['id'] as string,
    merchantId: row['merchant_id'] as string,
    name: row['name'] as string,
    status: row['status'] as ProjectRecord['status'],
    payoutAddress: (row['payout_address'] as string | null) ?? null,
    feeRateBps: toBigInt(row['fee_rate_bps']),
    feeFlatUnits: toBigInt(row['fee_flat_units']),
    toleranceUnderBps: toBigInt(row['tolerance_under_bps']),
    toleranceUnderFloor: toBigInt(row['tolerance_under_floor']),
    toleranceOverBps: toBigInt(row['tolerance_over_bps']),
    toleranceOverFloor: toBigInt(row['tolerance_over_floor']),
    webhookUrl: (row['webhook_url'] as string | null) ?? null,
    webhookSecret: (row['webhook_secret'] as string | null) ?? null,
  });
}

export async function findProject(id: string, client?: PoolClient): Promise<ProjectRecord | null> {
  const runner = client ?? getPool();
  const { rows } = await runner.query(
    `SELECT ${PROJECT_COLUMNS} FROM projects WHERE id = $1`,
    [id],
  );
  return rows[0] === undefined ? null : mapProject(rows[0]);
}

/**
 * Resolve an API key to its project.
 *
 * The lookup is by hash against a unique index, so a wrong key finds nothing
 * in constant work regardless of how close it was to a real one — there is no
 * comparison to time. Revoked keys are excluded in SQL rather than filtered
 * afterwards, so a revoked key cannot be authenticated by a caller that
 * forgets to check.
 */
export async function findProjectByApiKey(secret: string): Promise<ProjectRecord | null> {
  const { rows } = await getPool().query(
    `SELECT p.id AS project_row_id, ${PROJECT_COLUMNS
      .split(',')
      .map((c) => `p.${c.trim()}`)
      .join(', ')}, k.id AS key_id
       FROM api_keys k
       JOIN projects p ON p.id = k.project_id
      WHERE k.key_hash = $1 AND k.revoked_at IS NULL`,
    [hashApiKey(secret)],
  );

  const row = rows[0];
  if (row === undefined) return null;

  // Best-effort usage stamp. A failure here must not fail the request.
  void getPool()
    .query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [row['key_id']])
    .catch(() => {});

  return mapProject(row);
}
