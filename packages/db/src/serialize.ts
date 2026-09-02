/**
 * The public shape of a payment.
 *
 * Lives here, next to the record it is built from, because two places need it
 * and they must not drift: the API returns it, and a webhook carries it as a
 * snapshot of the moment the event happened. A merchant comparing the two
 * should see the same fields with the same names.
 *
 * Amounts are decimal STRINGS, never JSON numbers. `15000.50` survives a round
 * trip through a JSON number, but `90071992547409.91` does not, and the
 * receiving language may parse one into a float without being asked.
 *
 * Fields are written out one by one rather than spread from the record, so a
 * column added to the payments table cannot appear in a public payload by
 * accident.
 */

import { formatAmount, type Asset } from '@relay/core';

import type { PaymentRecord } from './payments.ts';

export interface PaymentView {
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

export function serializePayment(payment: PaymentRecord): PaymentView {
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
