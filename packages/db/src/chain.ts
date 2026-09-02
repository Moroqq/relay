/**
 * Recording what the chain showed, and keeping the indexer's place in it.
 */

import type { PoolClient } from 'pg';
import type { Asset } from '@relay/core';

import { getPool, inTransaction } from './pool.ts';

export interface ObservedTransfer {
  readonly txHash: string;
  readonly logIndex: number;
  readonly asset: Asset;
  readonly from: string;
  readonly to: string;
  readonly amountUnits: bigint;
}

export interface RecordResult {
  /** Transfers stored for the first time. A replayed block records nothing. */
  readonly inserted: number;
  /** Ids of payments touched by this batch, for the settlement pass. */
  readonly touchedPayments: string[];
}

/**
 * Store a block's transfers and attach each to a payment where one is waiting
 * on that address.
 *
 * `ON CONFLICT DO NOTHING` on (tx_hash, log_index) is what makes re-reading a
 * block harmless. That matters more than it sounds: the indexer will re-read
 * blocks after every restart and after every reorg, and a payment credited
 * twice is worse than one credited late.
 *
 * The payment lookup runs against `deposit_addresses` rather than trusting the
 * transfer's destination blindly, so money sent to an address we do not own is
 * simply not ours to record.
 */
export async function recordTransfers(
  transfers: readonly ObservedTransfer[],
  blockNumber: number,
  blockTime: Date,
): Promise<RecordResult> {
  if (transfers.length === 0) return { inserted: 0, touchedPayments: [] };

  return inTransaction(async (client) => {
    const touched = new Set<string>();
    let inserted = 0;

    for (const transfer of transfers) {
      // Only addresses we issued, and only the payment currently holding one.
      const { rows: matches } = await client.query<{ id: string; asset: Asset }>(
        `SELECT p.id, p.asset
           FROM payments p
          WHERE p.deposit_address = $1
          LIMIT 1`,
        [transfer.to],
      );

      const match = matches[0];
      // A transfer in the wrong asset to a real deposit address is recorded
      // but not attached: someone sending TRX to a USDT invoice has not paid
      // it, and a human needs to decide what happens to those funds.
      const paymentId = match !== undefined && match.asset === transfer.asset ? match.id : null;

      const { rowCount } = await client.query(
        `INSERT INTO chain_transfers (
           tx_hash, log_index, block_number, block_time, asset,
           from_address, to_address, amount_units, payment_id, matched_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CASE WHEN $9::text IS NULL THEN NULL ELSE now() END)
         ON CONFLICT (tx_hash, log_index) DO NOTHING`,
        [
          transfer.txHash,
          transfer.logIndex,
          blockNumber,
          blockTime,
          transfer.asset,
          transfer.from,
          transfer.to,
          transfer.amountUnits.toString(),
          paymentId,
        ],
      );

      if (rowCount === 1) {
        inserted += 1;
        if (paymentId !== null) touched.add(paymentId);
      }
    }

    return { inserted, touchedPayments: [...touched] };
  });
}

/**
 * Recalculate confirmations from the current chain head.
 *
 * Derived on every pass rather than incremented, so a restart, a missed cycle
 * or a reorg cannot leave a payment permanently stuck one confirmation short.
 */
export async function refreshConfirmations(headBlock: number): Promise<string[]> {
  const { rows } = await getPool().query<{ payment_id: string }>(
    `WITH updated AS (
       UPDATE chain_transfers
          SET confirmations = GREATEST($1::bigint - block_number + 1, 0)
        WHERE reverted_at IS NULL
          AND payment_id IS NOT NULL
          AND confirmations < (SELECT required_confirmations FROM payments p WHERE p.id = payment_id)
        RETURNING payment_id
     )
     SELECT DISTINCT payment_id FROM updated`,
    [headBlock],
  );
  return rows.map((row) => row.payment_id);
}

export async function getLastIndexedBlock(): Promise<number | null> {
  const { rows } = await getPool().query<{ last_block_number: string }>(
    'SELECT last_block_number FROM indexer_state WHERE id = TRUE',
  );
  return rows[0] === undefined ? null : Number(rows[0].last_block_number);
}

export async function setLastIndexedBlock(
  blockNumber: number,
  blockTime: Date,
  client?: PoolClient,
): Promise<void> {
  const runner = client ?? getPool();
  await runner.query(
    `INSERT INTO indexer_state (id, last_block_number, last_block_time, updated_at)
     VALUES (TRUE, $1, $2, now())
     ON CONFLICT (id) DO UPDATE
        SET last_block_number = EXCLUDED.last_block_number,
            last_block_time = EXCLUDED.last_block_time,
            updated_at = now()`,
    [blockNumber, blockTime],
  );
}

/**
 * Narrow a block's destination addresses down to the ones we issued.
 *
 * One query per block rather than one per transfer. On a busy block the
 * difference is a few hundred round trips, which is the difference between
 * keeping pace with a three-second block time and falling behind forever.
 */
export async function filterOwnedAddresses(
  addresses: readonly string[],
): Promise<ReadonlySet<string>> {
  if (addresses.length === 0) return new Set();

  const { rows } = await getPool().query<{ address: string }>(
    'SELECT address FROM deposit_addresses WHERE address = ANY($1::text[])',
    [[...new Set(addresses)]],
  );

  return new Set(rows.map((row) => row.address));
}

/** Payments that are open and could still be advanced by chain activity. */
export async function findOpenPaymentIds(): Promise<string[]> {
  const { rows } = await getPool().query<{ id: string }>(
    `SELECT id FROM payments WHERE state IN ('waiting', 'detected', 'confirming', 'underpaid')`,
  );
  return rows.map((row) => row.id);
}
