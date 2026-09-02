/**
 * Turning internal records into JSON a merchant reads.
 *
 * Two rules the rest of the service depends on.
 *
 * Amounts leave as decimal STRINGS, never JSON numbers. `15000.50` survives a
 * round trip through a JSON number, but `90071992547409.91` does not — and the
 * merchant's language may parse it into a float without asking. A string is
 * the only representation every client reads back exactly as we sent it.
 *
 * The response shape is written out field by field rather than spreading the
 * database record. A column added to a table must never appear in a public API
 * response by accident.
 */

import { formatAmount, type Asset } from '@relay/core';
import type { PaymentRecord } from '@relay/db';

export interface PaymentResponse {
  id: string;
  object: 'payment';
  state: string;
  asset: Asset;
  expected_amount: string;
  received_amount: string;
  fee_amount: string | null;
  net_amount: string | null;
  deposit_address: string;
  confirmations: number;
  required_confirmations: number;
  external_ref: string | null;
  created_at: string;
  expires_at: string;
  settled_at: string | null;
}

export function serializePayment(payment: PaymentRecord): PaymentResponse {
  const amount = (units: bigint): string => formatAmount(units, payment.asset);

  return {
    id: payment.id,
    object: 'payment',
    state: payment.state,
    asset: payment.asset,
    expected_amount: amount(payment.expectedUnits),
    received_amount: amount(payment.receivedUnits),
    fee_amount: payment.feeUnits === null ? null : amount(payment.feeUnits),
    net_amount: payment.netUnits === null ? null : amount(payment.netUnits),
    deposit_address: payment.depositAddress,
    confirmations: payment.confirmations,
    required_confirmations: payment.requiredConfirmations,
    external_ref: payment.externalRef,
    created_at: payment.createdAt.toISOString(),
    expires_at: payment.expiresAt.toISOString(),
    settled_at: payment.settledAt === null ? null : payment.settledAt.toISOString(),
  };
}
