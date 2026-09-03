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
import type { EndUserRecord } from './users.ts';
import type { DepositRecord } from './deposits.ts';

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

// ---------------------------------------------------------------------------
// The account model
// ---------------------------------------------------------------------------

export interface EndUserView {
  id: string;
  object: 'user';
  ref: string;
  deposit_address: string;
  status: string;
  created_at: string;
  last_deposit_at: string | null;
}

export function serializeEndUser(user: EndUserRecord): EndUserView {
  return {
    id: user.id,
    object: 'user',
    ref: user.externalRef,
    deposit_address: user.depositAddress,
    status: user.status,
    created_at: user.createdAt.toISOString(),
    last_deposit_at: user.lastDepositAt === null ? null : user.lastDepositAt.toISOString(),
  };
}

export interface DepositView {
  id: string;
  object: 'deposit';
  user_id: string;
  state: string;
  asset: Asset;
  amount: string;
  fee_amount: string | null;
  net_amount: string | null;
  confirmations: number;
  required_confirmations: number;
  tx_hash: string;
  detected_at: string;
  credited_at: string | null;
}

export function serializeDeposit(deposit: DepositRecord): DepositView {
  const amount = (units: bigint): string => formatAmount(units, deposit.asset);

  return {
    id: deposit.id,
    object: 'deposit',
    user_id: deposit.endUserId,
    state: deposit.state,
    asset: deposit.asset,
    amount: amount(deposit.amountUnits),
    fee_amount: deposit.feeUnits === null ? null : amount(deposit.feeUnits),
    net_amount: deposit.netUnits === null ? null : amount(deposit.netUnits),
    confirmations: deposit.confirmations,
    required_confirmations: deposit.requiredConfirmations,
    tx_hash: deposit.txHash,
    detected_at: deposit.detectedAt.toISOString(),
    credited_at: deposit.creditedAt === null ? null : deposit.creditedAt.toISOString(),
  };
}
