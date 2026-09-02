/**
 * Deciding what a payment has become, and recording it.
 *
 * This is the only place a payment's state changes as a result of chain
 * activity, and the only place money enters the ledger. Everything it decides
 * comes from `@relay/core`; everything it writes is inside one database
 * transaction, so a payment either settles completely — state, split, ledger,
 * webhook — or not at all.
 */

import type { PoolClient } from 'pg';
import {
  assertTransition,
  classifyReceipt,
  isSettled,
  newId,
  splitPayment,
  type PaymentState,
  type WebhookEvent,
} from '@relay/core';

import { inTransaction, toBigInt } from './pool.ts';
import { ACCOUNT_CODES, postLedgerTransaction } from './ledger.ts';
import { PAYMENT_COLUMNS, mapPayment, type PaymentRecord } from './payments.ts';
import { serializePayment } from './serialize.ts';

export interface SettlementOutcome {
  readonly paymentId: string;
  readonly previousState: PaymentState;
  readonly state: PaymentState;
  readonly changed: boolean;
  readonly confirmedUnits: bigint;
  readonly receivedUnits: bigint;
  readonly confirmations: number;
  readonly feeUnits: bigint | null;
  readonly netUnits: bigint | null;
}

const EVENT_FOR_STATE: Partial<Record<PaymentState, WebhookEvent>> = {
  detected: 'payment.detected',
  confirming: 'payment.confirming',
  completed: 'payment.completed',
  underpaid: 'payment.underpaid',
  overpaid: 'payment.overpaid',
  expired: 'payment.expired',
  failed: 'payment.failed',
};

interface Totals {
  readonly received: bigint;
  readonly confirmed: bigint;
  readonly confirmations: number;
  readonly transferCount: number;
}

async function readTotals(
  client: PoolClient,
  paymentId: string,
  required: number,
): Promise<Totals> {
  const { rows } = await client.query(
    `SELECT
       COALESCE(SUM(amount_units), 0)                                        AS received,
       COALESCE(SUM(amount_units) FILTER (WHERE confirmations >= $2), 0)     AS confirmed,
       COALESCE(MAX(confirmations), 0)                                       AS confirmations,
       COUNT(*)                                                              AS transfer_count
     FROM chain_transfers
     WHERE payment_id = $1 AND reverted_at IS NULL`,
    [paymentId, required],
  );

  const row = rows[0]!;
  return {
    received: toBigInt(row['received']),
    confirmed: toBigInt(row['confirmed']),
    confirmations: Number(row['confirmations']),
    transferCount: Number(row['transfer_count']),
  };
}

/**
 * What the payment should be, given what the chain now shows.
 *
 * Settlement is judged on CONFIRMED funds only. An unconfirmed transfer can
 * still disappear in a reorg, and a payment marked complete on one that does
 * is money we told the merchant to ship goods for.
 */
function nextState(
  current: PaymentState,
  totals: Totals,
  expected: bigint,
  tolerance: {
    underBps: bigint;
    underFloorUnits: bigint;
    overBps: bigint;
    overFloorUnits: bigint;
  },
): PaymentState {
  if (totals.transferCount === 0) return current;

  if (totals.confirmed > 0n) {
    const outcome = classifyReceipt(expected, totals.confirmed, tolerance);
    if (outcome === 'exact') return 'completed';
    if (outcome === 'over') return 'overpaid';
    // Confirmed but short: a top-up can still finish it, so this is not final.
    return 'underpaid';
  }

  // Seen but not yet final.
  return totals.confirmations > 0 ? 'confirming' : 'detected';
}

/**
 * Queue one notification.
 *
 * The payload is a snapshot taken now, not a reference resolved at delivery
 * time. A webhook describes what happened when it happened: if a retry six
 * hours later rebuilt the body from the current row, a merchant replaying
 * their queue would see a history that never occurred.
 */
async function enqueueWebhook(
  client: PoolClient,
  payment: PaymentRecord,
  state: PaymentState,
): Promise<void> {
  const event = EVENT_FOR_STATE[state];
  if (event === undefined) return;

  const { rows } = await client.query<{ webhook_url: string | null }>(
    'SELECT webhook_url FROM projects WHERE id = $1',
    [payment.projectId],
  );
  const endpoint = rows[0]?.webhook_url;
  // No endpoint configured is not an error: plenty of merchants poll instead.
  if (endpoint === null || endpoint === undefined || endpoint === '') return;

  await client.query(
    `INSERT INTO webhook_deliveries (id, payment_id, project_id, event, payload, endpoint)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
    [
      newId('webhookDelivery'),
      payment.id,
      payment.projectId,
      event,
      JSON.stringify({
        event,
        created_at: new Date().toISOString(),
        data: serializePayment(payment),
      }),
      endpoint,
    ],
  );
}

/**
 * Bring one payment up to date with the chain.
 *
 * Safe to call repeatedly and concurrently: the row is locked for the duration
 * and a payment already in its final state is left alone, so a replayed block
 * cannot settle the same money twice.
 */
export async function settlePayment(paymentId: string): Promise<SettlementOutcome | null> {
  return inTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, project_id, asset, state, expected_units, required_confirmations,
              fee_rate_bps, fee_flat_units,
              tolerance_under_bps, tolerance_under_floor,
              tolerance_over_bps, tolerance_over_floor
         FROM payments WHERE id = $1 FOR UPDATE`,
      [paymentId],
    );

    const payment = rows[0];
    if (payment === undefined) return null;

    const currentState = payment['state'] as PaymentState;
    const expected = toBigInt(payment['expected_units']);
    const required = Number(payment['required_confirmations']);

    const totals = await readTotals(client, paymentId, required);

    // Already final. Late money against a settled payment is recorded as an
    // unattached transfer for a human to deal with, never re-settled here.
    if (isSettled(currentState) || currentState === 'failed') {
      return {
        paymentId,
        previousState: currentState,
        state: currentState,
        changed: false,
        confirmedUnits: totals.confirmed,
        receivedUnits: totals.received,
        confirmations: totals.confirmations,
        feeUnits: null,
        netUnits: null,
      };
    }

    const target = nextState(currentState, totals, expected, {
      underBps: toBigInt(payment['tolerance_under_bps']),
      underFloorUnits: toBigInt(payment['tolerance_under_floor']),
      overBps: toBigInt(payment['tolerance_over_bps']),
      overFloorUnits: toBigInt(payment['tolerance_over_floor']),
    });

    if (target === currentState) {
      // Amount or confirmation count may still have moved.
      await client.query(
        'UPDATE payments SET received_units = $2, confirmations = $3 WHERE id = $1',
        [paymentId, totals.received.toString(), totals.confirmations],
      );
      return {
        paymentId,
        previousState: currentState,
        state: currentState,
        changed: false,
        confirmedUnits: totals.confirmed,
        receivedUnits: totals.received,
        confirmations: totals.confirmations,
        feeUnits: null,
        netUnits: null,
      };
    }

    // Refuses an illegal move loudly rather than writing it.
    assertTransition(currentState, target);

    let feeUnits: bigint | null = null;
    let netUnits: bigint | null = null;

    if (isSettled(target)) {
      const asset = payment['asset'] as 'USDT' | 'TRX';
      const projectId = payment['project_id'] as string;

      const split = splitPayment(totals.confirmed, asset, {
        rateBps: toBigInt(payment['fee_rate_bps']),
        flatUnits: toBigInt(payment['fee_flat_units']),
      });
      feeUnits = split.feeUnits;
      netUnits = split.netUnits;

      // We hold the gross; the merchant is owed the net; the fee is ours.
      // The three legs sum to zero, which is what the database will verify.
      await postLedgerTransaction(client, {
        kind: 'payment.settled',
        asset,
        paymentId,
        memo: `${target} ${paymentId}`,
        legs: [
          { code: ACCOUNT_CODES.deposits, projectId: null, amountUnits: split.grossUnits },
          { code: ACCOUNT_CODES.merchantPayable, projectId, amountUnits: -split.netUnits },
          { code: ACCOUNT_CODES.feeRevenue, projectId: null, amountUnits: -split.feeUnits },
        ],
      });
    }

    const { rows: updated } = await client.query(
      `UPDATE payments
          SET state = $2, received_units = $3, confirmations = $4,
              fee_units = $5, net_units = $6,
              first_detected_at = COALESCE(first_detected_at, now()),
              settled_at = CASE WHEN $7 THEN now() ELSE settled_at END
        WHERE id = $1
      RETURNING ${PAYMENT_COLUMNS}`,
      [
        paymentId,
        target,
        totals.received.toString(),
        totals.confirmations,
        feeUnits?.toString() ?? null,
        netUnits?.toString() ?? null,
        isSettled(target),
      ],
    );

    await enqueueWebhook(client, mapPayment(updated[0]!), target);

    return {
      paymentId,
      previousState: currentState,
      state: target,
      changed: true,
      confirmedUnits: totals.confirmed,
      receivedUnits: totals.received,
      confirmations: totals.confirmations,
      feeUnits,
      netUnits,
    };
  });
}

/** Close payments whose window ran out with nothing received. */
export async function expireStalePayments(): Promise<string[]> {
  const { rows } = await inTransaction(async (client) =>
    client.query<{ id: string }>(
      `UPDATE payments
          SET state = 'expired'
        WHERE state = 'waiting'
          AND expires_at < now()
          AND received_units = 0
        RETURNING id`,
    ),
  );
  return rows.map((row) => row.id);
}
