/**
 * Sending approved payouts from the hot wallet, and seeing them through.
 *
 * The one flow in the system that moves money to an address we do not own.
 * The order is the same as sweeping, and matters more here:
 *
 *   check funds -> estimate -> build -> verify -> sign -> CLAIM + PERSIST -> broadcast
 *
 * The claim and the persist are one statement. Of two workers that pick up
 * the same payout, exactly one stores its transaction; the other throws its
 * signature away and sends nothing.
 */

import { bytesToHex } from '@noble/hashes/utils.js';
import { estimateCost, formatAmount, dailyHoldings } from '@relay/core';
import {
  markPayoutFailed,
  recordPayoutBroadcast,
  recordPayoutCompleted,
  recordPayoutFailure,
  recordPayoutSigned,
  resetExpiredPayout,
  type PayoutRecord,
} from '@relay/db';
import type { ChainPrices, TronClient } from '@relay/tron';
import { decodeAddress, isValidAddress } from '@relay/wallet';

import { encodeTransfer } from './abi.ts';
import { signTransaction } from './sign.ts';
import { reconcileVerdict } from './payout-reconcile.ts';
import type { SweeperConfig } from './config.ts';

export type PayoutOutcome =
  | { readonly kind: 'waiting'; readonly reason: string }
  | { readonly kind: 'signed'; readonly txHash: string }
  | { readonly kind: 'broadcast'; readonly txHash: string }
  | { readonly kind: 'failed'; readonly reason: string };

const TRANSFER_BANDWIDTH_BYTES = 345n;

const usdt = (units: bigint): string => formatAmount(units, 'USDT', { trimTrailingZeros: true });
const trx = (sun: bigint): string => formatAmount(sun, 'TRX', { trimTrailingZeros: true });

export async function sendPayout(
  payout: PayoutRecord,
  client: TronClient,
  prices: ChainPrices,
  config: SweeperConfig,
): Promise<PayoutOutcome> {
  if (payout.asset !== 'USDT') {
    return { kind: 'waiting', reason: `${payout.asset} payouts are not implemented` };
  }
  // Checked when the request was made; checked again here, immediately before
  // a key signs, because this is the last moment a mistake is still free.
  if (!isValidAddress(payout.toAddress)) {
    await markPayoutFailed(payout.id, `destination fails its checksum: ${payout.toAddress}`);
    return { kind: 'failed', reason: 'destination address fails its checksum' };
  }

  const hot = config.hotWallet;
  const ownerHex = bytesToHex(decodeAddress(hot.address));
  const contractHex = bytesToHex(decodeAddress(config.usdtContract));
  const dataHex = encodeTransfer(payout.toAddress, payout.netUnits);
  const buildInput = { ownerHex, contractHex, parameterHex: dataHex.slice(8), feeLimitSun: config.feeLimitSun };

  // Not enough float is a normal state for a hot wallet, not an error: the
  // payout stays approved and goes out once someone refills from the treasury.
  const float = await client.readTokenBalance(contractHex, ownerHex);
  if (float < payout.netUnits) {
    return {
      kind: 'waiting',
      reason: `hot wallet holds ${usdt(float)} USDT, payout needs ${usdt(payout.netUnits)} — refill from the treasury`,
    };
  }

  const estimate = await client.estimateTransfer(buildInput);
  if (!estimate.willSucceed) {
    return { kind: 'waiting', reason: `transfer would revert: ${estimate.message ?? 'no reason given'}` };
  }

  // A payout sent without enough TRX for the fee reverts on chain after the
  // fee is taken, so the shortfall is found here instead.
  const account = await client.getAccountState(ownerHex);
  const cost = estimateCost(
    { energyUnits: estimate.energyUsed, bandwidthBytes: TRANSFER_BANDWIDTH_BYTES, activatesAccount: false },
    prices,
    { ...dailyHoldings(account.energyAvailable), bandwidthBytes: account.freeBandwidthAvailable },
  );
  if (account.trxSun < cost.totalSun) {
    return {
      kind: 'waiting',
      reason: `hot wallet holds ${trx(account.trxSun)} TRX, fees need ${trx(cost.totalSun)} — top up TRX or rent energy`,
    };
  }

  const built = await client.buildTransfer(buildInput);
  const signed = signTransaction(built, { ownerHex, contractHex, dataHex }, hot.privateKey);
  const txHash = signed.txID!;

  // A dry run proves the payout could be sent and writes nothing.
  if (config.payoutsDryRun) return { kind: 'signed', txHash };

  const won = await recordPayoutSigned(payout.id, txHash, signed, hot.address);
  if (!won) {
    return { kind: 'waiting', reason: 'another worker claimed this payout; discarded our signature' };
  }

  try {
    const result = await client.broadcast(signed);
    if (!result.accepted) {
      // Kept as signed rather than reset: the bytes are stored, and the
      // reconciler will only rebuild once their expiry has provably passed.
      await recordPayoutFailure(payout.id, `${result.code}: ${result.message}`);
      return { kind: 'failed', reason: `${result.code}: ${result.message}` };
    }
    await recordPayoutBroadcast(payout.id);
    return { kind: 'broadcast', txHash };
  } catch (error) {
    await recordPayoutFailure(payout.id, (error as Error).message);
    return { kind: 'failed', reason: (error as Error).message };
  }
}

export type ReconcileOutcome =
  | { readonly kind: 'completed'; readonly feeSun: bigint }
  | { readonly kind: 'failed'; readonly reason: string }
  | { readonly kind: 'rebuilt' }
  | { readonly kind: 'waiting'; readonly reason: string };

/**
 * Take one signed or broadcast payout one step closer to done.
 *
 * Both nodes are asked: the solidity node for "is this irreversible", the
 * ordinary node for "has this landed at all". The decision about what those
 * answers mean lives in `reconcileVerdict`, where it is tested branch by branch.
 */
export async function reconcilePayout(
  payout: PayoutRecord,
  client: TronClient,
  nowMs: number,
): Promise<ReconcileOutcome> {
  if (payout.txHash === null) {
    return { kind: 'waiting', reason: 'no transaction recorded' };
  }

  const [solidified, seen] = await Promise.all([
    client.getTransactionInfo(payout.txHash, { solidified: true }),
    client.getTransactionInfo(payout.txHash),
  ]);

  const verdict = reconcileVerdict({ solidified, seen }, payout.signedTx, payout.attempt, nowMs);

  switch (verdict.kind) {
    case 'complete':
      await recordPayoutCompleted(payout.id, verdict.feeSun);
      return { kind: 'completed', feeSun: verdict.feeSun };

    case 'failed_on_chain':
      await markPayoutFailed(payout.id, verdict.reason);
      return { kind: 'failed', reason: verdict.reason };

    case 'give_up':
      await markPayoutFailed(payout.id, verdict.reason);
      return { kind: 'failed', reason: verdict.reason };

    case 'rebuild':
      await resetExpiredPayout(payout.id, 'transaction expired without landing; rebuilding');
      return { kind: 'rebuilt' };

    case 'wait':
      return { kind: 'waiting', reason: verdict.reason };
  }
}
