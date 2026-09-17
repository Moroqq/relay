/**
 * Moving settled funds off deposit addresses.
 */

import type { PoolClient } from 'pg';
import type { Asset } from '@relay/core';
import { newId } from '@relay/core';

import { getPool, inTransaction, toBigInt } from './pool.ts';
import { ACCOUNT_CODES, postLedgerTransaction } from './ledger.ts';

export type SweepState = 'planned' | 'signed' | 'broadcast' | 'confirmed' | 'failed';

export interface SweepCandidate {
  readonly paymentId: string;
  readonly projectId: string;
  readonly depositAddress: string;
  readonly derivationIndex: number;
  readonly asset: Asset;
  /** What the merchant is owed — the gross minus our fee. */
  readonly netUnits: bigint;
  /** Where the merchant wants it. Null means the project never set one. */
  readonly payoutAddress: string | null;
}

/**
 * Settled payments whose funds are still sitting on a deposit address.
 *
 * Ordered oldest first so a backlog drains in the order merchants are waiting,
 * and joined against `sweeps` so anything already in flight is excluded — the
 * unique index makes a double sweep impossible, but there is no reason to
 * build a transaction that will be rejected.
 */
export async function findSweepCandidates(limit = 50): Promise<SweepCandidate[]> {
  const { rows } = await getPool().query(
    `SELECT p.id, p.project_id, p.deposit_address, p.asset, p.net_units,
            d.derivation_index, pr.payout_address
       FROM payments p
       JOIN deposit_addresses d ON d.address = p.deposit_address
       JOIN projects pr ON pr.id = p.project_id
       LEFT JOIN sweeps s ON s.payment_id = p.id AND s.state <> 'failed'
      WHERE p.state IN ('completed', 'overpaid')
        AND p.net_units IS NOT NULL
        AND p.net_units > 0
        AND s.id IS NULL
      ORDER BY p.settled_at
      LIMIT $1`,
    [limit],
  );

  return rows.map((row) =>
    Object.freeze({
      paymentId: row['id'] as string,
      projectId: row['project_id'] as string,
      depositAddress: row['deposit_address'] as string,
      derivationIndex: Number(row['derivation_index']),
      asset: row['asset'] as Asset,
      netUnits: toBigInt(row['net_units']),
      payoutAddress: (row['payout_address'] as string | null) ?? null,
    }),
  );
}

export interface SweepRecord {
  readonly id: string;
  readonly paymentId: string | null;
  readonly fromAddress: string;
  readonly toAddress: string;
  readonly asset: Asset;
  readonly amountUnits: bigint;
  readonly state: SweepState;
  readonly txHash: string | null;
  readonly signedTx: unknown;
  readonly attempt: number;
}

function mapSweep(row: Record<string, unknown>): SweepRecord {
  return Object.freeze({
    id: row['id'] as string,
    paymentId: (row['payment_id'] as string | null) ?? null,
    fromAddress: row['from_address'] as string,
    toAddress: row['to_address'] as string,
    asset: row['asset'] as Asset,
    amountUnits: toBigInt(row['amount_units']),
    state: row['state'] as SweepState,
    txHash: (row['tx_hash'] as string | null) ?? null,
    signedTx: row['signed_tx'] ?? null,
    attempt: row['attempt'] as number,
  });
}

const SWEEP_COLUMNS = `id, payment_id, end_user_id, from_address, to_address, asset,
                       amount_units, state, tx_hash, signed_tx, attempt`;

/**
 * Claim a payment for sweeping. Returns null if another worker got there first.
 *
 * The conflict target repeats the index's predicate because the index is
 * partial: once sweeps could belong to a user instead of a payment,
 * `UNIQUE (payment_id)` became `UNIQUE (payment_id) WHERE payment_id IS NOT
 * NULL`, and Postgres will not match a partial index unless the statement
 * names the same condition.
 */
export async function planSweep(candidate: SweepCandidate, toAddress: string): Promise<SweepRecord | null> {
  const { rows } = await getPool().query(
    `INSERT INTO sweeps (id, payment_id, from_address, to_address, asset, amount_units)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (payment_id) WHERE payment_id IS NOT NULL AND state <> 'failed' DO NOTHING
     RETURNING ${SWEEP_COLUMNS}`,
    [
      newId('ledgerTransaction').replace('LTX_', 'SWP_'),
      candidate.paymentId,
      candidate.depositAddress,
      toAddress,
      candidate.asset,
      candidate.netUnits.toString(),
    ],
  );
  return rows[0] === undefined ? null : mapSweep(rows[0]);
}

/**
 * Store the signed transaction before it is broadcast.
 *
 * This is the ordering that makes a crash survivable: the bytes and their
 * hash are on disk first, so a retry re-sends exactly the same transaction
 * instead of building a second one that would move the money twice.
 */
export async function recordSigned(
  sweepId: string,
  txHash: string,
  signedTx: unknown,
): Promise<void> {
  await getPool().query(
    `UPDATE sweeps SET state = 'signed', tx_hash = $2, signed_tx = $3::jsonb
      WHERE id = $1 AND state IN ('planned', 'signed')`,
    [sweepId, txHash, JSON.stringify(signedTx)],
  );
}

export async function recordBroadcast(sweepId: string): Promise<void> {
  await getPool().query(
    `UPDATE sweeps SET state = 'broadcast', broadcast_at = COALESCE(broadcast_at, now()),
                       attempt = attempt + 1
      WHERE id = $1`,
    [sweepId],
  );
}

/**
 * Record that an attempt went wrong.
 *
 * What happens next depends on how far the sweep got.
 *
 * Still `planned` means nothing was signed, so nothing can land: the sweep is
 * marked failed, which releases the address for the next pass. The first
 * version only counted the attempt and left the state alone, so a single node
 * timeout while building left the sweep planned forever — and because a
 * planned sweep holds the address, that address could never be swept again.
 *
 * Already `signed` or `broadcast` means stored bytes may yet land, so the
 * state is kept. Those are resolved by `expireSweep` once their expiry has
 * provably passed.
 */
export async function recordFailure(sweepId: string, error: string): Promise<void> {
  await getPool().query(
    `UPDATE sweeps
        SET attempt = attempt + 1,
            error = $2,
            state = CASE WHEN state = 'planned' THEN 'failed'::sweep_state_t ELSE state END
      WHERE id = $1`,
    [sweepId, error.slice(0, 500)],
  );
}

/**
 * Give up on a sweep whose transaction can never land.
 *
 * The caller must have checked that the stored transaction is past its expiry
 * and absent from the chain. Marking it failed releases the address, and the
 * funds are swept afresh on the next pass.
 */
export async function expireSweep(sweepId: string, reason: string): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `UPDATE sweeps SET state = 'failed', error = $2
      WHERE id = $1 AND state IN ('signed', 'broadcast')`,
    [sweepId, reason.slice(0, 500)],
  );
  return rowCount === 1;
}

/** Sweeps that are signed but not yet acknowledged by the network. */
export async function findUnfinishedSweeps(limit = 50): Promise<SweepRecord[]> {
  const { rows } = await getPool().query(
    `SELECT ${SWEEP_COLUMNS} FROM sweeps
      WHERE state IN ('signed', 'broadcast') ORDER BY created_at LIMIT $1`,
    [limit],
  );
  return rows.map(mapSweep);
}

/**
 * Record a confirmed sweep and post it to the ledger.
 *
 * Two movements, in two assets, because they cannot balance each other:
 *
 *   the payout      chain.deposits   −net    merchant.payable  +net   (USDT)
 *   the network fee chain.deposits   −fee    platform.gas_expense +fee (TRX)
 *
 * The first is what settles our debt: the merchant is owed nothing once the
 * money is in their wallet. The second records what the network took to do it.
 *
 * How TRX arrives on a deposit address in the first place — staked energy
 * delegated to it, or TRX sent from a gas wallet — is a separate flow that
 * does not exist yet. Until it does, the TRX leg of `chain.deposits` will run
 * negative, which is honest: it says we have spent TRX we have not yet
 * accounted for putting there.
 */
export async function recordConfirmed(
  sweepId: string,
  feeSun: bigint,
  energyUsed: bigint | null,
): Promise<void> {
  await inTransaction(async (client: PoolClient) => {
    const { rows } = await client.query(
      `UPDATE sweeps
          SET state = 'confirmed', confirmed_at = now(), fee_sun = $2, energy_used = $3
        WHERE id = $1 AND state <> 'confirmed'
      RETURNING ${SWEEP_COLUMNS}, payment_id`,
      [sweepId, feeSun.toString(), energyUsed === null ? null : energyUsed.toString()],
    );

    // Already confirmed by another worker; the ledger entry exists.
    if (rows[0] === undefined) return;

    const sweep = mapSweep(rows[0]);

    // A sweep belongs to a payment or to a user, never both. Either way the
    // debt being discharged is the project's.
    const { rows: subject } = await client.query<{ project_id: string }>(
      `SELECT COALESCE(p.project_id, u.project_id) AS project_id
         FROM sweeps s
         LEFT JOIN payments p ON p.id = s.payment_id
         LEFT JOIN end_users u ON u.id = s.end_user_id
        WHERE s.id = $1`,
      [sweepId],
    );
    const projectId = subject[0]!.project_id;

    await postLedgerTransaction(client, {
      kind: 'payout.sent',
      asset: sweep.asset,
      paymentId: sweep.paymentId,
      reference: sweep.txHash,
      memo: `swept ${sweep.amountUnits} to ${sweep.toAddress}`,
      legs: [
        { code: ACCOUNT_CODES.deposits, projectId: null, amountUnits: -sweep.amountUnits },
        { code: ACCOUNT_CODES.merchantPayable, projectId, amountUnits: sweep.amountUnits },
      ],
    });

    if (feeSun > 0n) {
      await postLedgerTransaction(client, {
        kind: 'gas.spent',
        asset: 'TRX',
        paymentId: sweep.paymentId,
        reference: sweep.txHash,
        memo: `network fee for ${sweep.txHash}`,
        legs: [
          { code: ACCOUNT_CODES.deposits, projectId: null, amountUnits: -feeSun },
          { code: ACCOUNT_CODES.gasExpense, projectId: null, amountUnits: feeSun },
        ],
      });
    }
  });
}

/** What a merchant is still owed, and what we hold, per asset. */
export async function readOutstanding(): Promise<
  { code: string; asset: Asset; projectId: string | null; balanceUnits: bigint }[]
> {
  const { rows } = await getPool().query(
    `SELECT code, asset, project_id, balance_units FROM ledger_balances
      WHERE entry_count > 0 ORDER BY code, asset`,
  );
  return rows.map((row) =>
    Object.freeze({
      code: row['code'] as string,
      asset: row['asset'] as Asset,
      projectId: (row['project_id'] as string | null) ?? null,
      balanceUnits: toBigInt(row['balance_units']),
    }),
  );
}
