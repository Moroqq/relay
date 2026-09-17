/**
 * What the console's browser code receives. Amounts are decimal strings, as
 * everywhere else, and nothing secret — no hash, no sealed secret, no counter —
 * ever leaves the server.
 */

import { formatAmount } from '@relay/core';
import type { ConsolePayout, ConsoleSummary, OperatorRecord, AuditRecord } from '@relay/db';

const usdt = (units: bigint): string => formatAmount(units, 'USDT');

export function operatorView(o: OperatorRecord) {
  return { id: o.id, email: o.email, name: o.name, role: o.role };
}

export function payoutView(p: ConsolePayout) {
  return {
    id: p.id,
    state: p.state,
    merchant: { id: p.merchantId, name: p.merchantName },
    project: { id: p.projectId, name: p.projectName },
    asset: p.asset,
    amount: formatAmount(p.amountUnits, p.asset),
    fee_amount: formatAmount(p.feeUnits, p.asset),
    net_amount: formatAmount(p.netUnits, p.asset),
    to_address: p.toAddress,
    from_address: p.fromAddress,
    external_ref: p.externalRef,
    tx_hash: p.txHash,
    approved_by: p.approvedBy === 'auto' ? 'automatic' : p.approverName,
    approved_at: p.approvedAt?.toISOString() ?? null,
    rejected_reason: p.rejectedReason,
    error: p.error,
    attempt: p.attempt,
    created_at: p.createdAt.toISOString(),
    completed_at: p.completedAt?.toISOString() ?? null,
  };
}

/**
 * A balance as the books have it, sign included.
 *
 * Operational wallet accounts can read negative — TRX spent on fees before any
 * TRX funding has been booked, for one. Clamping that to zero would show an
 * operator a wallet in order when it is not; the minus sign is the point.
 */
function signed(units: bigint, asset: 'USDT' | 'TRX'): string {
  return units < 0n ? '-' + formatAmount(-units, asset) : formatAmount(units, asset);
}

export function summaryView(s: ConsoleSummary) {
  return {
    counts: s.counts,
    awaiting_approval: usdt(s.awaitingApprovalUnits),
    approved_unsent: usdt(s.approvedUnsentUnits),
    hot_wallet: { usdt: signed(s.hotWalletUsdtUnits, 'USDT'), trx: signed(s.hotWalletTrxSun, 'TRX') },
    treasury: { usdt: signed(s.treasuryUsdtUnits, 'USDT') },
    merchants_owed: signed(s.merchantsOwedUnits, 'USDT'),
    // Approved payouts the hot wallet's booked balance cannot cover right now.
    hot_wallet_short: s.approvedUnsentUnits > s.hotWalletUsdtUnits,
  };
}

export function auditView(a: AuditRecord) {
  return {
    id: a.id,
    at: a.createdAt.toISOString(),
    operator: a.operatorName,
    action: a.action,
    subject: a.subjectType === null ? null : { type: a.subjectType, id: a.subjectId },
    detail: a.detail,
    ip: a.ip,
  };
}
