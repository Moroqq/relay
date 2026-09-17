/**
 * Reading one block and recording what belongs to us.
 */

import {
  filterOwnedAddresses,
  recordDeposit,
  recordInternalTransfer,
  recordTransfers,
  setLastIndexedBlock,
  type ObservedTransfer as StoredTransfer,
} from '@relay/db';

import { extractNativeTransfers, extractTrc20Transfers } from './decode.ts';
import type { IndexerConfig } from './config.ts';
import type { TronClient } from '@relay/tron';

export interface ScanResult {
  readonly blockNumber: number;
  readonly transfersSeen: number;
  readonly transfersOurs: number;
  readonly inserted: number;
  readonly touchedPayments: readonly string[];
  /** Deposits created by this block, in the account model. */
  readonly newDeposits: readonly string[];
  /** Movements between the treasury and the hot wallet booked from this block. */
  readonly internalTransfers: number;
}

/**
 * Scan a single block.
 *
 * Two calls: the block body carries native TRX transfers, the transaction-info
 * response carries TRC20 event logs. Neither contains the other.
 */
export async function scanBlock(
  client: TronClient,
  config: IndexerConfig,
  blockNumber: number,
  requiredConfirmations: number,
): Promise<ScanResult> {
  const [block, infos] = await Promise.all([
    client.getBlock(blockNumber),
    client.getBlockTransactionInfo(blockNumber),
  ]);

  const seen = [
    ...extractTrc20Transfers(infos, config.contracts),
    ...extractNativeTransfers(block.transactions),
  ];

  // Almost every transfer on the network is someone else's. One database
  // round trip decides which are ours, before any per-transfer work.
  const owned = await filterOwnedAddresses(seen.map((transfer) => transfer.to));
  const ours: StoredTransfer[] = seen
    .filter((transfer) => owned.has(transfer.to))
    .map((transfer) => ({
      txHash: transfer.txHash,
      logIndex: transfer.logIndex,
      asset: transfer.asset,
      from: transfer.from,
      to: transfer.to,
      amountUnits: transfer.amountUnits,
    }));

  const { inserted, touchedPayments } = await recordTransfers(ours, blockNumber, block.timestamp);

  // The two models share this walk. An address belongs to a payment or to a
  // user, never both, so exactly one of the two calls does anything with it.
  const newDeposits: string[] = [];
  for (const transfer of ours) {
    const created = await recordDeposit(
      {
        toAddress: transfer.to,
        asset: transfer.asset,
        amountUnits: transfer.amountUnits,
        txHash: transfer.txHash,
        logIndex: transfer.logIndex,
        blockNumber,
      },
      requiredConfirmations,
    );
    if (created !== null) newDeposits.push(created.id);
  }

  // Refills and returns between our own wallets. Checked against every
  // transfer in the block, not just the ones to deposit addresses, because
  // neither wallet is a deposit address.
  let internalTransfers = 0;
  if (config.operational !== null) {
    for (const transfer of seen) {
      const booked = await recordInternalTransfer(
        { ...transfer, blockNumber, blockTime: block.timestamp },
        config.operational,
      );
      if (booked !== null) internalTransfers += 1;
    }
  }

  // Recorded before the position advances, so a crash between the two re-reads
  // the block rather than skipping it. Inserts are idempotent, so re-reading
  // costs nothing; skipping would lose a payment silently.
  await setLastIndexedBlock(blockNumber, block.timestamp);

  return {
    blockNumber,
    transfersSeen: seen.length,
    transfersOurs: ours.length,
    inserted,
    touchedPayments,
    newDeposits,
    internalTransfers,
  };
}
