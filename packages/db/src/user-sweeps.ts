/**
 * Sweeping user addresses into the treasury.
 *
 * Separate from the invoice-model sweeps because the destination and the
 * bookkeeping differ. There, funds went to the merchant and the debt went with
 * them. Here they move between two accounts we control, and the merchant is
 * still owed every cent.
 */

import type { PoolClient } from 'pg';
import type { Asset } from '@relay/core';
import { newId } from '@relay/core';

import { getPool, inTransaction, toBigInt } from './pool.ts';
import { ACCOUNT_CODES, postLedgerTransaction } from './ledger.ts';

export interface UserSweepCandidate {
  readonly endUserId: string;
  readonly projectId: string;
  readonly depositAddress: string;
  readonly derivationIndex: number;
  readonly asset: Asset;
  /** Total credited but not yet moved off the address. */
  readonly pendingUnits: bigint;
  readonly depositCount: number;
}

/**
 * Addresses holding credited funds that have not been moved yet.
 *
 * Addresses with a sweep already in flight are excluded. The unique index
 * makes a second concurrent sweep impossible anyway, but there is no reason
 * to build a transaction that will be rejected — and worse, a second signed
 * transfer of funds the first one is already spending would fail on chain
 * after its fee was paid.
 *
 * Ordered by the oldest waiting deposit, so a backlog drains in the order
 * users deposited.
 */
export async function findUserSweepCandidates(limit = 50): Promise<UserSweepCandidate[]> {
  const { rows } = await getPool().query(
    `SELECT u.id            AS end_user_id,
            u.project_id,
            u.deposit_address,
            a.derivation_index,
            d.asset,
            SUM(d.amount_units) AS pending_units,
            COUNT(*)::int       AS deposit_count,
            MIN(d.credited_at)  AS oldest
       FROM deposits d
       JOIN end_users u ON u.id = d.end_user_id
       JOIN deposit_addresses a ON a.address = u.deposit_address
       LEFT JOIN sweeps s
              ON s.from_address = u.deposit_address
             AND s.state IN ('planned', 'signed', 'broadcast')
      WHERE d.state = 'credited'
        AND d.sweep_id IS NULL
        AND s.id IS NULL
      GROUP BY u.id, u.project_id, u.deposit_address, a.derivation_index, d.asset
      ORDER BY MIN(d.credited_at)
      LIMIT $1`,
    [limit],
  );

  return rows.map((row) =>
    Object.freeze({
      endUserId: row['end_user_id'] as string,
      projectId: row['project_id'] as string,
      depositAddress: row['deposit_address'] as string,
      derivationIndex: Number(row['derivation_index']),
      asset: row['asset'] as Asset,
      pendingUnits: toBigInt(row['pending_units']),
      depositCount: row['deposit_count'] as number,
    }),
  );
}

export interface UserSweepRecord {
  readonly id: string;
  readonly endUserId: string;
  readonly fromAddress: string;
  readonly toAddress: string;
  readonly asset: Asset;
  readonly amountUnits: bigint;
}

/**
 * Claim a user's address for sweeping.
 *
 * The conflict target repeats the index's predicate because the index is
 * partial: an address may be swept many times over its life, but never twice
 * at once.
 */
export async function planUserSweep(
  candidate: UserSweepCandidate,
  toAddress: string,
  amountUnits: bigint,
): Promise<UserSweepRecord | null> {
  const { rows } = await getPool().query(
    `INSERT INTO sweeps (id, end_user_id, from_address, to_address, asset, amount_units)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (from_address) WHERE state IN ('planned', 'signed', 'broadcast') DO NOTHING
     RETURNING id, end_user_id, from_address, to_address, asset, amount_units`,
    [
      newId('ledgerTransaction').replace('LTX_', 'SWP_'),
      candidate.endUserId,
      candidate.depositAddress,
      toAddress,
      candidate.asset,
      amountUnits.toString(),
    ],
  );

  const row = rows[0];
  if (row === undefined) return null;

  return Object.freeze({
    id: row['id'] as string,
    endUserId: row['end_user_id'] as string,
    fromAddress: row['from_address'] as string,
    toAddress: row['to_address'] as string,
    asset: row['asset'] as Asset,
    amountUnits: toBigInt(row['amount_units']),
  });
}

/**
 * Record a confirmed user sweep and post it.
 *
 * Two movements, in two assets, because they cannot balance each other:
 *
 *   the consolidation  chain.deposits −amount   chain.treasury +amount  (USDT)
 *   the network fee    chain.deposits −fee      platform.gas_expense +fee (TRX)
 *
 * Note what is NOT here: `merchant.payable` is untouched. The funds moved
 * between two accounts we control, so we still owe the merchant exactly what
 * we owed them before. Clearing the debt here would make the books show us
 * owing nothing while holding somebody else's money.
 *
 * The deposits this sweep emptied are stamped with its id inside the same
 * transaction, so they cannot be swept a second time.
 */
export async function recordUserSweepConfirmed(
  sweepId: string,
  feeSun: bigint,
  energyUsed: bigint | null,
): Promise<{ depositsSettled: number } | null> {
  return inTransaction(async (client: PoolClient) => {
    const { rows } = await client.query(
      `UPDATE sweeps
          SET state = 'confirmed', confirmed_at = now(), fee_sun = $2, energy_used = $3
        WHERE id = $1 AND end_user_id IS NOT NULL AND state <> 'confirmed'
      RETURNING id, end_user_id, from_address, asset, amount_units, tx_hash, to_address`,
      [sweepId, feeSun.toString(), energyUsed === null ? null : energyUsed.toString()],
    );

    // Already confirmed by another worker; its entries exist.
    if (rows[0] === undefined) return null;

    const sweep = rows[0];
    const asset = sweep['asset'] as Asset;
    const amountUnits = toBigInt(sweep['amount_units']);

    // Stamp the deposits whose funds this moved. Restricted to the address
    // and to unswept rows, so a later sweep of the same address cannot claim
    // deposits an earlier one already carried.
    const { rowCount } = await client.query(
      `UPDATE deposits d
          SET sweep_id = $1
         FROM end_users u
        WHERE u.id = d.end_user_id
          AND u.deposit_address = $2
          AND d.state = 'credited'
          AND d.sweep_id IS NULL`,
      [sweepId, sweep['from_address']],
    );

    await postLedgerTransaction(client, {
      kind: 'sweep.consolidated',
      asset,
      reference: (sweep['tx_hash'] as string | null) ?? null,
      memo: `swept ${sweep['from_address']} into ${sweep['to_address']}`,
      legs: [
        { code: ACCOUNT_CODES.deposits, projectId: null, amountUnits: -amountUnits },
        { code: ACCOUNT_CODES.treasury, projectId: null, amountUnits },
      ],
    });

    if (feeSun > 0n) {
      await postLedgerTransaction(client, {
        kind: 'gas.spent',
        asset: 'TRX',
        reference: (sweep['tx_hash'] as string | null) ?? null,
        memo: `network fee for sweeping ${sweep['from_address']}`,
        legs: [
          { code: ACCOUNT_CODES.deposits, projectId: null, amountUnits: -feeSun },
          { code: ACCOUNT_CODES.gasExpense, projectId: null, amountUnits: feeSun },
        ],
      });
    }

    return { depositsSettled: rowCount ?? 0 };
  });
}
