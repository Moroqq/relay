/**
 * Sweeping one payment's funds to the merchant.
 *
 * The order of operations is the whole design:
 *
 *   estimate -> decide -> claim -> build -> verify -> sign -> PERSIST -> broadcast
 *
 * Persisting the signed transaction before broadcasting is what makes a crash
 * survivable. TRON's transaction id is the hash of its body, so it is fixed at
 * signing time; a retry re-sends the same bytes and the network accepts them
 * once. Building a fresh transaction on retry would send the money twice.
 */

import { bytesToHex } from '@noble/hashes/utils.js';
import { decideSweep, estimateCost, formatAmount, type SweepDecision } from '@relay/core';
import {
  planSweep,
  planUserSweep,
  recordBroadcast,
  recordFailure,
  recordSigned,
  type SweepCandidate,
  type UserSweepCandidate,
} from '@relay/db';
import { decodeAddress, isValidAddress } from '@relay/wallet';
import type { ChainPrices, TronClient } from '@relay/tron';

import { encodeTransfer } from './abi.ts';
import { signTransaction } from './sign.ts';
import type { SweeperConfig } from './config.ts';

export type SweepOutcome =
  | { readonly kind: 'skipped'; readonly reason: string }
  | { readonly kind: 'uneconomic'; readonly decision: SweepDecision }
  | { readonly kind: 'signed'; readonly txHash: string; readonly decision: SweepDecision }
  | { readonly kind: 'broadcast'; readonly txHash: string; readonly decision: SweepDecision }
  | { readonly kind: 'failed'; readonly reason: string };

/** Bandwidth a TRC20 transfer occupies. Measured, not guessed at. */
const TRANSFER_BANDWIDTH_BYTES = 345n;

export async function sweepPayment(
  candidate: SweepCandidate,
  client: TronClient,
  prices: ChainPrices,
  config: SweeperConfig,
): Promise<SweepOutcome> {
  // Non-custodial means the money goes to the merchant, so there must be a
  // merchant address. Without one the funds stay where they are — parking
  // them is recoverable, sending them somewhere invented is not.
  const payout = candidate.payoutAddress;
  if (payout === null || payout === '') {
    return { kind: 'skipped', reason: 'project has no payout address' };
  }
  if (!isValidAddress(payout)) {
    return { kind: 'skipped', reason: `payout address fails its checksum: ${payout}` };
  }
  if (candidate.asset !== 'USDT') {
    return { kind: 'skipped', reason: `sweeping ${candidate.asset} is not implemented` };
  }

  const ownerHex = bytesToHex(decodeAddress(candidate.depositAddress));
  const contractHex = bytesToHex(decodeAddress(config.usdtContract));
  const dataHex = encodeTransfer(payout, candidate.netUnits);
  const parameterHex = dataHex.slice(8);

  const buildInput = { ownerHex, contractHex, parameterHex, feeLimitSun: config.feeLimitSun };

  // The ledger says these funds exist; the chain is what decides. Reading the
  // balance first turns "the transfer reverted for some reason" into a
  // specific, actionable line in the log, and costs one call to find out.
  const onChain = await client.readTokenBalance(contractHex, ownerHex);
  if (onChain < candidate.netUnits) {
    return {
      kind: 'skipped',
      reason:
        `address holds ${formatAmount(onChain, 'USDT', { trimTrailingZeros: true })} USDT, ` +
        `needs ${formatAmount(candidate.netUnits, 'USDT', { trimTrailingZeros: true })}`,
    };
  }

  // Simulate second. A reverting transfer still burns the fee limit, and
  // finding out here costs nothing — but only if the answer is read properly:
  // the node reports a revert while still saying the simulation itself ran.
  const estimate = await client.estimateTransfer(buildInput);
  if (!estimate.willSucceed) {
    return { kind: 'failed', reason: `transfer would revert: ${estimate.message ?? 'no reason given'}` };
  }

  const cost = estimateCost(
    {
      energyUnits: estimate.energyUsed,
      bandwidthBytes: TRANSFER_BANDWIDTH_BYTES,
      activatesAccount: false,
    },
    prices,
  );

  const decision = decideSweep(
    candidate.netUnits,
    cost.totalSun,
    config.trxPriceUnits,
    config.policy,
  );

  // Not worth moving today. Nothing is lost: the funds stay on the address and
  // the decision is made again next pass, against fresh prices.
  if (!decision.worthwhile) return { kind: 'uneconomic', decision };

  const sweep = await planSweep(candidate, payout);
  if (sweep === null) {
    return { kind: 'skipped', reason: 'another worker already claimed this payment' };
  }

  try {
    const built = await client.buildTransfer(buildInput);

    // Re-reads the transaction the node returned and refuses to sign anything
    // that is not what we asked for, including a txID that is not the hash of
    // the bytes it sent.
    const signed = signTransaction(built, { ownerHex, contractHex, dataHex },
      config.wallet.derivePrivateKey(candidate.derivationIndex));

    const txHash = signed.txID!;
    await recordSigned(sweep.id, txHash, signed);

    if (config.dryRun) return { kind: 'signed', txHash, decision };

    const result = await client.broadcast(signed);
    if (!result.accepted) {
      await recordFailure(sweep.id, `${result.code}: ${result.message}`);
      return { kind: 'failed', reason: `${result.code}: ${result.message}` };
    }

    await recordBroadcast(sweep.id);
    return { kind: 'broadcast', txHash, decision };
  } catch (error) {
    await recordFailure(sweep.id, (error as Error).message);
    return { kind: 'failed', reason: (error as Error).message };
  }
}

export function describeDecision(decision: SweepDecision, asset: 'USDT' | 'TRX'): string {
  return (
    `${formatAmount(decision.valueUnits, asset, { trimTrailingZeros: true })} ${asset}` +
    ` minus ${formatAmount(decision.costUnits, asset, { trimTrailingZeros: true })} fee` +
    ` = ${formatAmount(decision.netUnits, asset, { trimTrailingZeros: true })}`
  );
}

// ---------------------------------------------------------------------------
// The account model
// ---------------------------------------------------------------------------

/**
 * Sweep a user's address into the treasury.
 *
 * Differs from a payment sweep in two ways that matter. The destination is our
 * own treasury rather than a merchant's wallet, so the ledger records a
 * consolidation and leaves the debt standing. And the amount is whatever the
 * address actually holds — a user may have topped up several times since the
 * last sweep, and the chain is the authority on the total, not our sum of
 * credited deposits.
 */
export async function sweepUserAddress(
  candidate: UserSweepCandidate,
  client: TronClient,
  prices: ChainPrices,
  config: SweeperConfig,
): Promise<SweepOutcome> {
  if (candidate.asset !== 'USDT') {
    return { kind: 'skipped', reason: `sweeping ${candidate.asset} is not implemented` };
  }

  const ownerHex = bytesToHex(decodeAddress(candidate.depositAddress));
  const contractHex = bytesToHex(decodeAddress(config.usdtContract));

  // The chain decides how much is there. Our ledger says what was credited;
  // the address may hold more (a deposit not yet credited) or less (a sweep
  // that landed after we last looked).
  const onChain = await client.readTokenBalance(contractHex, ownerHex);
  if (onChain === 0n) {
    return { kind: 'skipped', reason: 'address holds nothing' };
  }

  const dataHex = encodeTransfer(config.treasuryAddress, onChain);
  const buildInput = {
    ownerHex,
    contractHex,
    parameterHex: dataHex.slice(8),
    feeLimitSun: config.feeLimitSun,
  };

  const estimate = await client.estimateTransfer(buildInput);
  if (!estimate.willSucceed) {
    return { kind: 'failed', reason: `transfer would revert: ${estimate.message ?? 'no reason given'}` };
  }

  const cost = estimateCost(
    {
      energyUnits: estimate.energyUsed,
      bandwidthBytes: TRANSFER_BANDWIDTH_BYTES,
      activatesAccount: false,
    },
    prices,
  );

  const decision = decideSweep(onChain, cost.totalSun, config.trxPriceUnits, config.policy);
  if (!decision.worthwhile) return { kind: 'uneconomic', decision };

  const sweep = await planUserSweep(candidate, config.treasuryAddress, onChain);
  if (sweep === null) {
    return { kind: 'skipped', reason: 'a sweep of this address is already in flight' };
  }

  try {
    const built = await client.buildTransfer(buildInput);
    const signed = signTransaction(
      built,
      { ownerHex, contractHex, dataHex },
      config.wallet.derivePrivateKey(candidate.derivationIndex),
    );

    const txHash = signed.txID!;
    await recordSigned(sweep.id, txHash, signed);

    if (config.dryRun) return { kind: 'signed', txHash, decision };

    const result = await client.broadcast(signed);
    if (!result.accepted) {
      await recordFailure(sweep.id, `${result.code}: ${result.message}`);
      return { kind: 'failed', reason: `${result.code}: ${result.message}` };
    }

    await recordBroadcast(sweep.id);
    return { kind: 'broadcast', txHash, decision };
  } catch (error) {
    await recordFailure(sweep.id, (error as Error).message);
    return { kind: 'failed', reason: (error as Error).message };
  }
}
