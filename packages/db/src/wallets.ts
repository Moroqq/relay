/**
 * Money moving between the wallets we operate.
 *
 * The treasury's key is not on any server, so topping up the hot wallet is
 * something a person does with their own wallet software. The system learns of
 * it the way it learns of everything else: by reading the transfer off the
 * chain. Without this the hot wallet's ledger account would only ever go down,
 * and the books would show a wallet with a negative balance paying merchants.
 */

import type { Asset } from '@relay/core';

import { inTransaction } from './pool.ts';
import { ACCOUNT_CODES, postLedgerTransaction } from './ledger.ts';

export interface OperationalAddresses {
  readonly treasury: string;
  readonly hotWallet: string;
}

export interface ObservedWalletTransfer {
  readonly txHash: string;
  readonly logIndex: number;
  readonly blockNumber: number;
  readonly blockTime: Date;
  readonly asset: Asset;
  readonly from: string;
  readonly to: string;
  readonly amountUnits: bigint;
}

export type InternalDirection = 'refill' | 'return';

/** Whether a transfer is between our own two operational wallets, and which way. */
export function internalDirection(
  transfer: Pick<ObservedWalletTransfer, 'from' | 'to'>,
  wallets: OperationalAddresses,
): InternalDirection | null {
  if (transfer.from === wallets.treasury && transfer.to === wallets.hotWallet) return 'refill';
  if (transfer.from === wallets.hotWallet && transfer.to === wallets.treasury) return 'return';
  return null;
}

/**
 * Book a transfer between the treasury and the hot wallet.
 *
 * Recorded in `chain_transfers` first, keyed on (tx_hash, log_index), and the
 * ledger entry is posted only if that insert actually happened — so a block
 * read twice books the movement once.
 *
 * Money arriving at the hot wallet from anywhere else is deliberately not
 * booked here. It might be ours, or it might be a stranger's mistake, and
 * guessing wrong in either direction puts somebody else's money on our books.
 */
export async function recordInternalTransfer(
  transfer: ObservedWalletTransfer,
  wallets: OperationalAddresses,
): Promise<InternalDirection | null> {
  const direction = internalDirection(transfer, wallets);
  if (direction === null) return null;

  return inTransaction(async (client) => {
    const { rowCount } = await client.query(
      `INSERT INTO chain_transfers (
         tx_hash, log_index, block_number, block_time, asset,
         from_address, to_address, amount_units
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (tx_hash, log_index) DO NOTHING`,
      [
        transfer.txHash,
        transfer.logIndex,
        transfer.blockNumber,
        transfer.blockTime,
        transfer.asset,
        transfer.from,
        transfer.to,
        transfer.amountUnits.toString(),
      ],
    );
    if (rowCount !== 1) return null;

    const into = direction === 'refill' ? ACCOUNT_CODES.hotWallet : ACCOUNT_CODES.treasury;
    const outOf = direction === 'refill' ? ACCOUNT_CODES.treasury : ACCOUNT_CODES.hotWallet;

    await postLedgerTransaction(client, {
      kind: direction === 'refill' ? 'hot_wallet.refilled' : 'hot_wallet.returned',
      asset: transfer.asset,
      reference: transfer.txHash,
      memo: `${transfer.from} -> ${transfer.to}`,
      legs: [
        { code: outOf, projectId: null, amountUnits: -transfer.amountUnits },
        { code: into, projectId: null, amountUnits: transfer.amountUnits },
      ],
    });

    return direction;
  });
}
