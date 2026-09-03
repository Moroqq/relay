/**
 * Writing to the ledger.
 *
 * Nothing here decides how much money moves — that is `@relay/core`. This only
 * records the movement, and the database refuses anything that does not
 * balance, so a bug in the caller becomes a failed transaction rather than a
 * quiet discrepancy.
 */

import type { PoolClient } from 'pg';
import type { Asset } from '@relay/core';
import { newId } from '@relay/core';

/** Platform-wide accounts. `project_id` is NULL for these. */
export const ACCOUNT_CODES = {
  /** Funds sitting on deposit addresses we control. */
  deposits: 'chain.deposits',
  /** The main wallet everything is consolidated into. Still ours, still owed. */
  treasury: 'chain.treasury',
  /** Our cut. */
  feeRevenue: 'platform.fee_revenue',
  /** Network fees we pay to move funds. */
  gasExpense: 'platform.gas_expense',
  /** What we owe a merchant. Always carries a project_id. */
  merchantPayable: 'merchant.payable',
} as const;

const ACCOUNT_KINDS: Record<string, 'asset' | 'liability' | 'revenue' | 'expense'> = {
  [ACCOUNT_CODES.deposits]: 'asset',
  [ACCOUNT_CODES.treasury]: 'asset',
  [ACCOUNT_CODES.feeRevenue]: 'revenue',
  [ACCOUNT_CODES.gasExpense]: 'expense',
  [ACCOUNT_CODES.merchantPayable]: 'liability',
};

/**
 * Find or create an account.
 *
 * Accounts appear on first use rather than being seeded up front, so adding an
 * asset or a merchant needs no migration. The uniqueness constraint treats
 * NULL project_id as a value, so a platform account can only ever exist once.
 */
export async function ensureAccount(
  client: PoolClient,
  code: string,
  asset: Asset,
  projectId: string | null,
): Promise<string> {
  const kind = ACCOUNT_KINDS[code];
  if (kind === undefined) throw new Error(`Unknown ledger account code: ${code}`);

  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO ledger_accounts (id, code, kind, asset, project_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (code, asset, project_id) DO UPDATE SET code = EXCLUDED.code
     RETURNING id`,
    [newId('ledgerAccount'), code, kind, asset, projectId],
  );

  return rows[0]!.id;
}

export interface LedgerLeg {
  readonly code: string;
  readonly projectId: string | null;
  /** Positive is money we hold; negative is money we owe or have earned. */
  readonly amountUnits: bigint;
}

export interface PostOptions {
  readonly kind: string;
  readonly asset: Asset;
  readonly legs: readonly LedgerLeg[];
  readonly paymentId?: string | null;
  readonly payoutId?: string | null;
  readonly reference?: string | null;
  readonly memo?: string | null;
}

/**
 * Post one balanced movement.
 *
 * The legs are not checked here on purpose. The deferred constraint in the
 * database checks them at commit, and that is the check that cannot be
 * bypassed — duplicating it in TypeScript would only create a second place for
 * the rule to drift.
 */
export async function postLedgerTransaction(
  client: PoolClient,
  options: PostOptions,
): Promise<string> {
  const transactionId = newId('ledgerTransaction');

  await client.query(
    `INSERT INTO ledger_transactions (id, kind, payment_id, reference, memo, payout_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      transactionId,
      options.kind,
      options.paymentId ?? null,
      options.reference ?? null,
      options.memo ?? null,
      options.payoutId ?? null,
    ],
  );

  for (const leg of options.legs) {
    // A zero leg carries no information and only clutters a statement.
    if (leg.amountUnits === 0n) continue;

    const accountId = await ensureAccount(client, leg.code, options.asset, leg.projectId);
    await client.query(
      `INSERT INTO ledger_entries (transaction_id, account_id, asset, amount_units)
       VALUES ($1, $2, $3, $4)`,
      [transactionId, accountId, options.asset, leg.amountUnits.toString()],
    );
  }

  return transactionId;
}

export interface AccountBalance {
  readonly code: string;
  readonly asset: Asset;
  readonly projectId: string | null;
  readonly balanceUnits: bigint;
}

export async function readBalances(client: PoolClient): Promise<AccountBalance[]> {
  const { rows } = await client.query(
    `SELECT code, asset, project_id, balance_units FROM ledger_balances
      WHERE entry_count > 0 ORDER BY code, asset`,
  );
  return rows.map((row) =>
    Object.freeze({
      code: row['code'] as string,
      asset: row['asset'] as Asset,
      projectId: (row['project_id'] as string | null) ?? null,
      balanceUnits: BigInt(row['balance_units'] as string),
    }),
  );
}
