/**
 * Paying merchants out of the treasury.
 *
 * The one place money leaves for an address we do not own, and the only
 * operation here with no undo. Everything in this file is arranged around
 * that: what is available comes from the ledger rather than a stored number,
 * requests in flight reserve their amount, and the balance check happens
 * under a lock so two requests cannot each spend it.
 */

import type { PoolClient } from 'pg';
import type { Asset } from '@relay/core';
import { newId, splitPayment } from '@relay/core';

import { getPool, inTransaction, toBigInt, toBigIntOrNull, isUniqueViolation } from './pool.ts';
import { ACCOUNT_CODES, postLedgerTransaction } from './ledger.ts';

export type PayoutState =
  | 'requested'
  | 'approved'
  | 'signed'
  | 'broadcast'
  | 'completed'
  | 'rejected'
  | 'failed';

/** States in which a payout still has a claim on the balance. */
const RESERVING_STATES = ['requested', 'approved', 'signed', 'broadcast'] as const;

export interface MerchantBalance {
  readonly projectId: string;
  readonly asset: Asset;
  /** What the ledger says we owe, before anything is reserved. */
  readonly owedUnits: bigint;
  /** Claimed by payouts already in flight. */
  readonly reservedUnits: bigint;
  /** What a new payout may draw on. */
  readonly availableUnits: bigint;
}

/**
 * What a merchant may withdraw.
 *
 * Derived from ledger entries every time rather than kept in a column. A
 * stored balance is a second source of truth, and the moment it disagrees
 * with the entries behind it there is no way to tell which is right.
 */
export async function readMerchantBalance(
  projectId: string,
  asset: Asset = 'USDT',
  client?: PoolClient,
): Promise<MerchantBalance> {
  const runner = client ?? getPool();

  const { rows } = await runner.query(
    `SELECT
       COALESCE((
         SELECT -SUM(e.amount_units)
           FROM ledger_entries e
           JOIN ledger_accounts a ON a.id = e.account_id
          WHERE a.code = $2 AND a.project_id = $1 AND a.asset = $3
       ), 0) AS owed,
       COALESCE((
         SELECT SUM(p.amount_units)
           FROM payouts p
          WHERE p.project_id = $1 AND p.asset = $3 AND p.state = ANY($4::payout_state_t[])
       ), 0) AS reserved`,
    [projectId, ACCOUNT_CODES.merchantPayable, asset, RESERVING_STATES],
  );

  const owedUnits = toBigInt(rows[0]!['owed']);
  const reservedUnits = toBigInt(rows[0]!['reserved']);
  const availableUnits = owedUnits - reservedUnits;

  return Object.freeze({
    projectId,
    asset,
    owedUnits,
    reservedUnits,
    // A negative available balance would mean we reserved more than we owe,
    // which the request path prevents; clamped so callers never see one.
    availableUnits: availableUnits > 0n ? availableUnits : 0n,
  });
}

export interface PayoutRecord {
  readonly id: string;
  readonly projectId: string;
  readonly externalRef: string | null;
  readonly asset: Asset;
  readonly amountUnits: bigint;
  readonly feeUnits: bigint;
  readonly netUnits: bigint;
  readonly toAddress: string;
  readonly fromAddress: string | null;
  readonly state: PayoutState;
  readonly txHash: string | null;
  readonly signedTx: unknown;
  readonly approvedBy: string | null;
  readonly rejectedReason: string | null;
  readonly attempt: number;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
}

export const PAYOUT_COLUMNS = `
  id, project_id, external_ref, asset, amount_units, fee_units, net_units,
  to_address, from_address, state, tx_hash, signed_tx, approved_by, rejected_reason,
  attempt, created_at, completed_at
`;

export function mapPayout(row: Record<string, unknown>): PayoutRecord {
  return Object.freeze({
    id: row['id'] as string,
    projectId: row['project_id'] as string,
    externalRef: (row['external_ref'] as string | null) ?? null,
    asset: row['asset'] as Asset,
    amountUnits: toBigInt(row['amount_units']),
    feeUnits: toBigInt(row['fee_units']),
    netUnits: toBigInt(row['net_units']),
    toAddress: row['to_address'] as string,
    fromAddress: (row['from_address'] as string | null) ?? null,
    state: row['state'] as PayoutState,
    txHash: (row['tx_hash'] as string | null) ?? null,
    signedTx: row['signed_tx'] ?? null,
    approvedBy: (row['approved_by'] as string | null) ?? null,
    rejectedReason: (row['rejected_reason'] as string | null) ?? null,
    attempt: row['attempt'] as number,
    createdAt: row['created_at'] as Date,
    completedAt: (row['completed_at'] as Date | null) ?? null,
  });
}

export class PayoutError extends Error {
  override readonly name = 'PayoutError';
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface RequestPayoutInput {
  readonly projectId: string;
  readonly externalRef: string | null;
  readonly asset: Asset;
  /** Gross: what comes off the merchant's balance. */
  readonly amountUnits: bigint;
  readonly toAddress: string;
}

export interface RequestPayoutResult {
  readonly payout: PayoutRecord;
  /** False when an existing payout was returned for a repeated reference. */
  readonly created: boolean;
}

/**
 * Request a payout.
 *
 * The project row is locked for the duration, which is what serialises two
 * simultaneous requests: without it both would read the same available
 * balance and both would pass a check that only one of them should.
 *
 * Nothing is sent here. The request either goes straight to approved, when it
 * is at or under the project's automatic limit, or waits for a person.
 */
export async function requestPayout(input: RequestPayoutInput): Promise<RequestPayoutResult> {
  try {
    return await inTransaction(async (client) => {
      const { rows: projects } = await client.query(
        `SELECT id, status, payout_fee_bps, payout_fee_flat_units, payout_auto_approve_units
           FROM projects WHERE id = $1 FOR UPDATE`,
        [input.projectId],
      );
      const project = projects[0];
      if (project === undefined) {
        throw new PayoutError('project_not_found', `Unknown project ${input.projectId}`);
      }
      if (project['status'] !== 'active') {
        throw new PayoutError('project_inactive', `Project ${input.projectId} is ${project['status']}`);
      }

      if (input.externalRef !== null) {
        const { rows: existing } = await client.query(
          `SELECT ${PAYOUT_COLUMNS} FROM payouts WHERE project_id = $1 AND external_ref = $2`,
          [input.projectId, input.externalRef],
        );
        if (existing[0] !== undefined) {
          return { payout: mapPayout(existing[0]), created: false };
        }
      }

      const balance = await readMerchantBalance(input.projectId, input.asset, client);
      if (input.amountUnits > balance.availableUnits) {
        throw new PayoutError(
          'insufficient_balance',
          `Requested ${input.amountUnits} but only ${balance.availableUnits} is available`,
        );
      }

      // The withdrawal charge, separate from the percentage already taken when
      // the deposits were credited. Reuses the same split so a fee can never
      // exceed the amount it is taken from.
      const split = splitPayment(input.amountUnits, input.asset, {
        rateBps: toBigInt(project['payout_fee_bps']),
        flatUnits: toBigInt(project['payout_fee_flat_units']),
      });
      if (split.netUnits <= 0n) {
        throw new PayoutError(
          'amount_below_fee',
          'The withdrawal fee would consume the whole amount',
        );
      }

      const autoLimit = toBigInt(project['payout_auto_approve_units']);
      const state: PayoutState =
        autoLimit > 0n && input.amountUnits <= autoLimit ? 'approved' : 'requested';

      const { rows } = await client.query(
        `INSERT INTO payouts (
           id, project_id, external_ref, asset, amount_units, fee_units, net_units,
           to_address, state, approved_by, approved_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::payout_state_t, $10,
                   -- Both uses of $9 are cast explicitly. Postgres deduces a
                   -- parameter's type from its first use, so comparing an enum
                   -- against a bare literal makes it text in one place and the
                   -- enum in the other, and the statement will not plan.
                   CASE WHEN $9::text = 'approved' THEN now() ELSE NULL END)
         RETURNING ${PAYOUT_COLUMNS}`,
        [
          newId('payout'),
          input.projectId,
          input.externalRef,
          input.asset,
          input.amountUnits.toString(),
          split.feeUnits.toString(),
          split.netUnits.toString(),
          input.toAddress,
          state,
          state === 'approved' ? 'auto' : null,
        ],
      );

      return { payout: mapPayout(rows[0]!), created: true };
    });
  } catch (error) {
    // Lost the race against a simultaneous retry of the same reference.
    if (input.externalRef !== null && isUniqueViolation(error)) {
      const existing = await findPayoutByRef(input.projectId, input.externalRef);
      if (existing !== null) return { payout: existing, created: false };
    }
    throw error;
  }
}

export async function findPayout(id: string): Promise<PayoutRecord | null> {
  const { rows } = await getPool().query(
    `SELECT ${PAYOUT_COLUMNS} FROM payouts WHERE id = $1`,
    [id],
  );
  return rows[0] === undefined ? null : mapPayout(rows[0]);
}

export async function findPayoutByRef(
  projectId: string,
  externalRef: string,
): Promise<PayoutRecord | null> {
  const { rows } = await getPool().query(
    `SELECT ${PAYOUT_COLUMNS} FROM payouts WHERE project_id = $1 AND external_ref = $2`,
    [projectId, externalRef],
  );
  return rows[0] === undefined ? null : mapPayout(rows[0]);
}

export async function listPayouts(
  projectId: string,
  options: { limit?: number } = {},
): Promise<PayoutRecord[]> {
  const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);
  const { rows } = await getPool().query(
    `SELECT ${PAYOUT_COLUMNS} FROM payouts
      WHERE project_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [projectId, limit],
  );
  return rows.map(mapPayout);
}

/**
 * Clear a payout to be sent.
 *
 * Guarded on the current state rather than read-then-write, so two approvals
 * arriving together cannot both succeed and a rejected payout cannot be
 * approved afterwards.
 */
export async function approvePayout(id: string, approvedBy: string): Promise<PayoutRecord | null> {
  const { rows } = await getPool().query(
    `UPDATE payouts
        SET state = 'approved', approved_by = $2, approved_at = now()
      WHERE id = $1 AND state = 'requested'
    RETURNING ${PAYOUT_COLUMNS}`,
    [id, approvedBy],
  );
  return rows[0] === undefined ? null : mapPayout(rows[0]);
}

/** Refuse a payout. The amount it reserved returns to the available balance. */
export async function rejectPayout(id: string, reason: string): Promise<PayoutRecord | null> {
  const { rows } = await getPool().query(
    `UPDATE payouts
        SET state = 'rejected', rejected_reason = $2
      WHERE id = $1 AND state = 'requested'
    RETURNING ${PAYOUT_COLUMNS}`,
    [id, reason.slice(0, 500)],
  );
  return rows[0] === undefined ? null : mapPayout(rows[0]);
}

/** Approved payouts waiting to be sent, oldest first. */
export async function findSendablePayouts(limit = 20): Promise<PayoutRecord[]> {
  const { rows } = await getPool().query(
    `SELECT ${PAYOUT_COLUMNS} FROM payouts
      WHERE state = 'approved' ORDER BY created_at LIMIT $1`,
    [limit],
  );
  return rows.map(mapPayout);
}

/** Payouts already signed or sent, for reconciliation against the chain. */
export async function findUnfinishedPayouts(limit = 50): Promise<PayoutRecord[]> {
  const { rows } = await getPool().query(
    `SELECT ${PAYOUT_COLUMNS} FROM payouts
      WHERE state IN ('signed', 'broadcast') ORDER BY created_at LIMIT $1`,
    [limit],
  );
  return rows.map(mapPayout);
}

/**
 * Store the signed transaction before it goes out, and claim the payout.
 *
 * This update is the claim. It only succeeds from `approved`, so of two
 * workers that picked up the same payout exactly one gets a row back; the
 * other must discard what it signed and send nothing.
 *
 * The first version accepted `signed` as a starting state too. Two workers
 * would each sign a different transaction — TRON's id covers a timestamp, so
 * they differ — the second would overwrite the first's bytes, and both would
 * broadcast. The merchant would be paid twice out of the hot wallet.
 *
 * Returns whether this caller won. A caller that did not win must not
 * broadcast.
 */
export async function recordPayoutSigned(
  payoutId: string,
  txHash: string,
  signedTx: unknown,
  fromAddress: string,
): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `UPDATE payouts
        SET state = 'signed', tx_hash = $2, signed_tx = $3::jsonb, from_address = $4
      WHERE id = $1 AND state = 'approved'`,
    [payoutId, txHash, JSON.stringify(signedTx), fromAddress],
  );
  return rowCount === 1;
}

/**
 * Return a payout whose transaction can never land to the send queue.
 *
 * TRON transactions carry an expiry roughly a minute after they are built. A
 * signed payout whose expiry has passed and which is not on chain will never
 * be on chain, so it is safe to throw the bytes away and build again. The
 * caller is responsible for having checked both of those things; the state
 * guard here only makes sure nothing completed is ever reopened.
 */
export async function resetExpiredPayout(payoutId: string, reason: string): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `UPDATE payouts
        SET state = 'approved', tx_hash = NULL, signed_tx = NULL, from_address = NULL,
            error = $2
      WHERE id = $1 AND state IN ('signed', 'broadcast')`,
    [payoutId, reason.slice(0, 500)],
  );
  return rowCount === 1;
}

/**
 * Stop trying to send a payout.
 *
 * Used when the transaction reverted on chain — the network took its fee and
 * moved nothing — or when attempts are exhausted. Deliberately not a reset to
 * `approved`: a revert usually means the hot wallet lacks funds or energy,
 * and retrying automatically would burn a fee each time until someone
 * noticed. `failed` releases the reservation and puts it in front of a person.
 */
export async function markPayoutFailed(payoutId: string, reason: string): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `UPDATE payouts SET state = 'failed', error = $2
      WHERE id = $1 AND state IN ('approved', 'signed', 'broadcast')`,
    [payoutId, reason.slice(0, 500)],
  );
  return rowCount === 1;
}

export async function recordPayoutBroadcast(payoutId: string): Promise<void> {
  await getPool().query(
    `UPDATE payouts SET state = 'broadcast', attempt = attempt + 1 WHERE id = $1`,
    [payoutId],
  );
}

export async function recordPayoutFailure(payoutId: string, error: string): Promise<void> {
  await getPool().query(
    'UPDATE payouts SET attempt = attempt + 1, error = $2 WHERE id = $1',
    [payoutId, error.slice(0, 500)],
  );
}

/**
 * Record a completed payout and post it.
 *
 *   merchant.payable  +gross   the debt is settled
 *   chain.hot_wallet  −net     that much left the wallet that signed it
 *   platform.fee_revenue −fee  the withdrawal charge, if any
 *
 * The signs are worth reading carefully. `merchant.payable` is a liability and
 * therefore negative; adding to it moves it toward zero, which is what paying
 * somebody does. The hot wallet is an asset and goes down by what actually left,
 * which is the net — the fee never leaves the building.
 */
export async function recordPayoutCompleted(
  payoutId: string,
  feeSun: bigint,
): Promise<PayoutRecord | null> {
  return inTransaction(async (client: PoolClient) => {
    const { rows } = await client.query(
      `UPDATE payouts
          SET state = 'completed', completed_at = now(), fee_sun = $2
        WHERE id = $1 AND state <> 'completed'
      RETURNING ${PAYOUT_COLUMNS}`,
      [payoutId, feeSun.toString()],
    );

    // Already completed by another worker; its entries exist.
    if (rows[0] === undefined) return null;

    const payout = mapPayout(rows[0]);

    await postLedgerTransaction(client, {
      kind: 'payout.paid',
      asset: payout.asset,
      payoutId: payout.id,
      reference: payout.txHash,
      memo: `paid ${payout.netUnits} to ${payout.toAddress}`,
      legs: [
        { code: ACCOUNT_CODES.merchantPayable, projectId: payout.projectId, amountUnits: payout.amountUnits },
        { code: ACCOUNT_CODES.hotWallet, projectId: null, amountUnits: -payout.netUnits },
        { code: ACCOUNT_CODES.feeRevenue, projectId: null, amountUnits: -payout.feeUnits },
      ],
    });

    if (feeSun > 0n) {
      await postLedgerTransaction(client, {
        kind: 'gas.spent',
        asset: 'TRX',
        payoutId: payout.id,
        reference: payout.txHash,
        memo: `network fee for payout ${payout.id}`,
        legs: [
          { code: ACCOUNT_CODES.hotWallet, projectId: null, amountUnits: -feeSun },
          { code: ACCOUNT_CODES.gasExpense, projectId: null, amountUnits: feeSun },
        ],
      });
    }

    return payout;
  });
}
