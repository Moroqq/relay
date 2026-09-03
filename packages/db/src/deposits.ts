/**
 * Deposits: money that arrived, rather than money that was asked for.
 *
 * The whole state machine is four values wide because there is nothing to
 * compare the amount against. A deposit is seen, buried deep enough to trust,
 * and credited. The only way back is a reorg.
 */

import type { PoolClient } from 'pg';
import type { Asset } from '@relay/core';
import { newId, splitPayment } from '@relay/core';

import { getPool, inTransaction, toBigInt, toBigIntOrNull, isUniqueViolation } from './pool.ts';
import { ACCOUNT_CODES, postLedgerTransaction } from './ledger.ts';
import { serializeDeposit } from './serialize.ts';

export type DepositState = 'detected' | 'confirming' | 'credited' | 'failed';

export interface DepositRecord {
  readonly id: string;
  readonly endUserId: string;
  readonly projectId: string;
  readonly asset: Asset;
  readonly amountUnits: bigint;
  readonly state: DepositState;
  readonly confirmations: number;
  readonly requiredConfirmations: number;
  readonly txHash: string;
  readonly logIndex: number;
  readonly blockNumber: number;
  readonly feeUnits: bigint | null;
  readonly netUnits: bigint | null;
  readonly detectedAt: Date;
  readonly creditedAt: Date | null;
}

export const DEPOSIT_COLUMNS = `
  id, end_user_id, project_id, asset, amount_units, state,
  confirmations, required_confirmations, tx_hash, log_index, block_number,
  fee_units, net_units, detected_at, credited_at
`;

export function mapDeposit(row: Record<string, unknown>): DepositRecord {
  return Object.freeze({
    id: row['id'] as string,
    endUserId: row['end_user_id'] as string,
    projectId: row['project_id'] as string,
    asset: row['asset'] as Asset,
    amountUnits: toBigInt(row['amount_units']),
    state: row['state'] as DepositState,
    confirmations: row['confirmations'] as number,
    requiredConfirmations: row['required_confirmations'] as number,
    txHash: row['tx_hash'] as string,
    logIndex: row['log_index'] as number,
    blockNumber: Number(row['block_number']),
    feeUnits: toBigIntOrNull(row['fee_units']),
    netUnits: toBigIntOrNull(row['net_units']),
    detectedAt: row['detected_at'] as Date,
    creditedAt: (row['credited_at'] as Date | null) ?? null,
  });
}

export interface ObservedDeposit {
  readonly toAddress: string;
  readonly asset: Asset;
  readonly amountUnits: bigint;
  readonly txHash: string;
  readonly logIndex: number;
  readonly blockNumber: number;
}

/**
 * Record a transfer that landed on a user's address.
 *
 * Returns null when the address belongs to nobody — money sent to an address
 * we did not issue is not ours to credit — and when the transfer has already
 * been recorded, which is what makes re-reading a block harmless.
 *
 * The project's pricing is copied onto the row here rather than read at credit
 * time, so a rate change between detection and confirmation cannot rewrite
 * what this deposit was charged.
 */
export async function recordDeposit(
  observed: ObservedDeposit,
  requiredConfirmations: number,
): Promise<DepositRecord | null> {
  try {
    return await inTransaction(async (client) => {
      const { rows: users } = await client.query<{
        id: string;
        project_id: string;
        status: string;
        fee_rate_bps: string;
        fee_flat_units: string;
      }>(
        `SELECT u.id, u.project_id, u.status, p.fee_rate_bps, p.fee_flat_units
           FROM end_users u
           JOIN projects p ON p.id = u.project_id
          WHERE u.deposit_address = $1`,
        [observed.toAddress],
      );

      const user = users[0];
      if (user === undefined) return null;

      const { rows } = await client.query(
        `INSERT INTO deposits (
           id, end_user_id, project_id, asset, amount_units,
           required_confirmations, tx_hash, log_index, block_number,
           fee_rate_bps, fee_flat_units
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING ${DEPOSIT_COLUMNS}`,
        [
          newId('deposit'),
          user.id,
          user.project_id,
          observed.asset,
          observed.amountUnits.toString(),
          requiredConfirmations,
          observed.txHash,
          observed.logIndex,
          observed.blockNumber,
          user.fee_rate_bps,
          user.fee_flat_units,
        ],
      );

      await client.query('UPDATE end_users SET last_deposit_at = now() WHERE id = $1', [user.id]);

      return mapDeposit(rows[0]!);
    });
  } catch (error) {
    // Already recorded. A replayed block reaches here and does nothing, which
    // is the entire reason the unique index on (tx_hash, log_index) exists.
    if (isUniqueViolation(error)) return null;
    throw error;
  }
}

/**
 * Queue a notification carrying the same shape the API returns.
 *
 * Built with the shared serializer rather than by hand: amounts leave as
 * decimal strings, exactly as `GET /v1/deposits` renders them. The first
 * version of this function assembled the payload itself and sent raw base
 * units, so a merchant reading 247500000 from a webhook and 247.500000 from
 * the API would have had to know which was which.
 */
async function enqueueDepositWebhook(
  client: PoolClient,
  deposit: DepositRecord,
  externalRef: string,
  event: string,
): Promise<void> {
  const { rows } = await client.query<{ webhook_url: string | null }>(
    'SELECT webhook_url FROM projects WHERE id = $1',
    [deposit.projectId],
  );
  const endpoint = rows[0]?.webhook_url;
  if (endpoint === null || endpoint === undefined || endpoint === '') return;

  await client.query(
    `INSERT INTO webhook_deliveries (id, deposit_id, project_id, event, payload, endpoint)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
    [
      newId('webhookDelivery'),
      deposit.id,
      deposit.projectId,
      event,
      JSON.stringify({
        event,
        created_at: new Date().toISOString(),
        // The merchant credits their own user, so they must be told which one.
        data: { ...serializeDeposit(deposit), user_ref: externalRef },
      }),
      endpoint,
    ],
  );
}

export interface CreditOutcome {
  readonly deposit: DepositRecord;
  readonly changed: boolean;
}

/**
 * Advance a deposit toward being credited, and credit it once it is deep
 * enough.
 *
 * Safe to call repeatedly and concurrently: the row is locked and a credited
 * deposit is left alone, so a replayed block cannot credit the same money
 * twice. Confirmations are recomputed from the chain head by the caller
 * rather than incremented here, so a restart cannot strand a deposit one
 * short.
 */
export async function creditDeposit(
  depositId: string,
  confirmations: number,
): Promise<CreditOutcome | null> {
  return inTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT ${DEPOSIT_COLUMNS}, fee_rate_bps, fee_flat_units
         FROM deposits WHERE id = $1 FOR UPDATE`,
      [depositId],
    );
    const row = rows[0];
    if (row === undefined) return null;

    const deposit = mapDeposit(row);
    if (deposit.state === 'credited' || deposit.state === 'failed') {
      return { deposit, changed: false };
    }

    const { rows: userRows } = await client.query<{ external_ref: string }>(
      'SELECT external_ref FROM end_users WHERE id = $1',
      [deposit.endUserId],
    );
    const externalRef = userRows[0]?.external_ref ?? '';

    // Not deep enough yet. Record the progress and stop.
    if (confirmations < deposit.requiredConfirmations) {
      const target: DepositState = confirmations > 0 ? 'confirming' : 'detected';
      const { rows: updated } = await client.query(
        `UPDATE deposits SET state = $2, confirmations = $3 WHERE id = $1
         RETURNING ${DEPOSIT_COLUMNS}`,
        [depositId, target, confirmations],
      );
      return { deposit: mapDeposit(updated[0]!), changed: target !== deposit.state };
    }

    const split = splitPayment(deposit.amountUnits, deposit.asset, {
      rateBps: toBigInt(row['fee_rate_bps']),
      flatUnits: toBigInt(row['fee_flat_units']),
    });

    // We hold the gross; the merchant is owed the net; the fee is ours. The
    // three legs sum to zero, which the database verifies at commit.
    await postLedgerTransaction(client, {
      kind: 'deposit.credited',
      asset: deposit.asset,
      reference: deposit.txHash,
      memo: `deposit ${deposit.id} for user ${externalRef}`,
      legs: [
        { code: ACCOUNT_CODES.deposits, projectId: null, amountUnits: split.grossUnits },
        { code: ACCOUNT_CODES.merchantPayable, projectId: deposit.projectId, amountUnits: -split.netUnits },
        { code: ACCOUNT_CODES.feeRevenue, projectId: null, amountUnits: -split.feeUnits },
      ],
    });

    const { rows: credited } = await client.query(
      `UPDATE deposits
          SET state = 'credited', confirmations = $2,
              fee_units = $3, net_units = $4, credited_at = now()
        WHERE id = $1
      RETURNING ${DEPOSIT_COLUMNS}`,
      [depositId, confirmations, split.feeUnits.toString(), split.netUnits.toString()],
    );

    const result = mapDeposit(credited[0]!);
    await enqueueDepositWebhook(client, result, externalRef, 'deposit.credited');

    return { deposit: result, changed: true };
  });
}

/** Deposits still waiting to be credited. */
export async function findOpenDeposits(limit = 200): Promise<DepositRecord[]> {
  const { rows } = await getPool().query(
    `SELECT ${DEPOSIT_COLUMNS} FROM deposits
      WHERE state IN ('detected', 'confirming') ORDER BY detected_at LIMIT $1`,
    [limit],
  );
  return rows.map(mapDeposit);
}

export async function findDeposit(id: string): Promise<DepositRecord | null> {
  const { rows } = await getPool().query(
    `SELECT ${DEPOSIT_COLUMNS} FROM deposits WHERE id = $1`,
    [id],
  );
  return rows[0] === undefined ? null : mapDeposit(rows[0]);
}

export async function listDeposits(
  projectId: string,
  options: { endUserId?: string; limit?: number } = {},
): Promise<DepositRecord[]> {
  const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);
  const { rows } = await getPool().query(
    `SELECT ${DEPOSIT_COLUMNS} FROM deposits
      WHERE project_id = $1 AND ($2::text IS NULL OR end_user_id = $2)
      ORDER BY detected_at DESC LIMIT $3`,
    [projectId, options.endUserId ?? null, limit],
  );
  return rows.map(mapDeposit);
}
