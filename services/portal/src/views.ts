/**
 * What the portal's browser code receives. Amounts are decimal strings;
 * nothing secret — no hash, no sealed secret, no webhook secret — leaves the
 * server except at the one moment a merchant creates it.
 */

import { formatAmount } from '@relay/core';
import type { ApiKeyRecord, DepositRecord, MerchantBalance, MerchantUserRecord, PayoutRecord, ProjectRecord } from '@relay/db';

export function meView(user: MerchantUserRecord, network: string) {
  return {
    user: { id: user.id, email: user.email, name: user.name },
    merchant: { id: user.merchantId, name: user.merchantName },
    network,
  };
}

const balanceView = (b: MerchantBalance) => ({
  available: formatAmount(b.availableUnits, b.asset),
  reserved: formatAmount(b.reservedUnits, b.asset),
  owed: formatAmount(b.owedUnits, b.asset),
});

export function projectView(p: ProjectRecord, balances: { usdt: MerchantBalance; trx: MerchantBalance }) {
  return {
    id: p.id,
    name: p.name,
    status: p.status,
    fee_percent: (Number(p.feeRateBps) / 100).toString(),
    webhook_url: p.webhookUrl,
    has_webhook_secret: p.webhookSecret !== null,
    balance: { usdt: balanceView(balances.usdt), trx: balanceView(balances.trx) },
  };
}

export function payoutView(p: PayoutRecord) {
  return {
    id: p.id,
    state: p.state,
    asset: p.asset,
    amount: formatAmount(p.amountUnits, p.asset),
    fee_amount: formatAmount(p.feeUnits, p.asset),
    net_amount: formatAmount(p.netUnits, p.asset),
    to_address: p.toAddress,
    tx_hash: p.txHash,
    rejected_reason: p.rejectedReason,
    created_at: p.createdAt.toISOString(),
    completed_at: p.completedAt?.toISOString() ?? null,
  };
}

export function depositView(d: DepositRecord) {
  return {
    id: d.id,
    user: d.endUserId,
    asset: d.asset,
    amount: formatAmount(d.amountUnits, d.asset),
    credited: d.netUnits === null ? null : formatAmount(d.netUnits, d.asset),
    state: d.state,
    confirmations: d.confirmations,
    required_confirmations: d.requiredConfirmations,
    tx_hash: d.txHash,
    detected_at: d.detectedAt.toISOString(),
  };
}

export function apiKeyView(k: ApiKeyRecord) {
  return {
    id: k.id,
    label: k.label,
    prefix: k.prefix,
    created_at: k.createdAt.toISOString(),
    last_used_at: k.lastUsedAt?.toISOString() ?? null,
    revoked_at: k.revokedAt?.toISOString() ?? null,
  };
}
