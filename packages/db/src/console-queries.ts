/**
 * What the operations console reads.
 */

import { toBigInt } from './pool.ts';
import { getPool } from './pool.ts';
import { PAYOUT_COLUMNS, mapPayout, type PayoutRecord } from './payouts.ts';
import { ACCOUNT_CODES } from './ledger.ts';

/** How the console groups payouts into tabs. */
export const PAYOUT_TABS = {
  requested: ['requested'],
  approved: ['approved'],
  in_flight: ['signed', 'broadcast'],
  completed: ['completed'],
  failed: ['failed'],
  rejected: ['rejected'],
  all: ['requested', 'approved', 'signed', 'broadcast', 'completed', 'failed', 'rejected'],
} as const;

export type PayoutTab = keyof typeof PAYOUT_TABS;

export function isPayoutTab(value: unknown): value is PayoutTab {
  return typeof value === 'string' && Object.hasOwn(PAYOUT_TABS, value);
}

export interface ConsolePayout extends PayoutRecord {
  readonly projectName: string;
  readonly merchantId: string;
  readonly merchantName: string;
  readonly error: string | null;
  readonly approvedAt: Date | null;
  /** Who approved it, by name; null when approved automatically or not yet. */
  readonly approverName: string | null;
}

export async function listConsolePayouts(tab: PayoutTab, limit = 100): Promise<ConsolePayout[]> {
  const columns = PAYOUT_COLUMNS.split(',').map((c) => 'p.' + c.trim()).join(', ');
  const { rows } = await getPool().query(
    `SELECT ${columns}, p.error, p.approved_at,
            pr.name AS project_name, m.id AS merchant_id, m.name AS merchant_name,
            o.name AS approver_name
       FROM payouts p
       JOIN projects pr ON pr.id = p.project_id
       JOIN merchants m ON m.id = pr.merchant_id
       -- approved_by holds an operator id, or 'auto' for the automatic limit.
       LEFT JOIN operators o ON o.id = p.approved_by
      WHERE p.state = ANY($1::payout_state_t[])
      ORDER BY p.created_at DESC
      LIMIT $2`,
    [PAYOUT_TABS[tab], Math.min(Math.max(limit, 1), 500)],
  );
  return rows.map((row) => Object.freeze({
    ...mapPayout(row),
    projectName: row['project_name'] as string,
    merchantId: row['merchant_id'] as string,
    merchantName: row['merchant_name'] as string,
    error: (row['error'] as string | null) ?? null,
    approvedAt: (row['approved_at'] as Date | null) ?? null,
    approverName: (row['approver_name'] as string | null) ?? null,
  }));
}

export interface ConsoleSummary {
  readonly counts: Readonly<Record<PayoutTab, number>>;
  /** Everything waiting on a person, and its total. */
  readonly awaitingApprovalUnits: bigint;
  /** Approved but not yet sent — what the hot wallet must be able to cover. */
  readonly approvedUnsentUnits: bigint;
  /** What the books say each operational wallet holds. */
  readonly hotWalletUsdtUnits: bigint;
  readonly hotWalletTrxSun: bigint;
  readonly treasuryUsdtUnits: bigint;
  /** What the platform owes merchants in total. */
  readonly merchantsOwedUnits: bigint;
}

export async function readConsoleSummary(): Promise<ConsoleSummary> {
  const pool = getPool();

  const { rows: states } = await pool.query(
    `SELECT state::text AS state, COUNT(*)::int AS n, COALESCE(SUM(amount_units), 0)::text AS total
       FROM payouts GROUP BY state`,
  );
  const byState = new Map(states.map((r) => [r['state'] as string, { n: r['n'] as number, total: toBigInt(r['total']) }]));
  const count = (list: readonly string[]) => list.reduce((sum, s) => sum + (byState.get(s)?.n ?? 0), 0);

  const counts = Object.fromEntries(
    Object.entries(PAYOUT_TABS).map(([tab, list]) => [tab, count(list)]),
  ) as Record<PayoutTab, number>;

  const { rows: balances } = await pool.query(
    `SELECT code, asset, COALESCE(SUM(balance_units), 0)::text AS balance
       FROM ledger_balances WHERE code = ANY($1::text[]) GROUP BY code, asset`,
    [[ACCOUNT_CODES.hotWallet, ACCOUNT_CODES.treasury, ACCOUNT_CODES.merchantPayable]],
  );
  const balance = (code: string, asset: string): bigint =>
    toBigInt(balances.find((r) => r['code'] === code && r['asset'] === asset)?.['balance'] ?? '0');

  return Object.freeze({
    counts,
    awaitingApprovalUnits: byState.get('requested')?.total ?? 0n,
    approvedUnsentUnits: byState.get('approved')?.total ?? 0n,
    hotWalletUsdtUnits: balance(ACCOUNT_CODES.hotWallet, 'USDT'),
    hotWalletTrxSun: balance(ACCOUNT_CODES.hotWallet, 'TRX'),
    treasuryUsdtUnits: balance(ACCOUNT_CODES.treasury, 'USDT'),
    // A liability is negative in the ledger; the console shows what is owed.
    merchantsOwedUnits: -balance(ACCOUNT_CODES.merchantPayable, 'USDT'),
  });
}
