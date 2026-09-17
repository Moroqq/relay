/**
 * What to do with a payout that has been signed, given what the chain shows.
 *
 * Pure, so every branch can be tested without a network — because every
 * branch is a way to lose money. Book a payout done that never landed and the
 * merchant is shown money they did not get. Rebuild one that might still land
 * and they are paid twice.
 */

import { isPastExpiry } from '@relay/tron';
import type { RawTransactionInfo } from '@relay/tron';

export type ReconcileVerdict =
  /** Irreversibly on chain and succeeded. Book it. */
  | { readonly kind: 'complete'; readonly feeSun: bigint }
  /** Irreversibly on chain and reverted. The fee is gone; nothing moved. */
  | { readonly kind: 'failed_on_chain'; readonly reason: string }
  /** Not decided yet. Look again next pass. */
  | { readonly kind: 'wait'; readonly reason: string }
  /** Provably can never land. Safe to throw the bytes away and build again. */
  | { readonly kind: 'rebuild' }
  /** Provably can never land, and we have tried enough times. */
  | { readonly kind: 'give_up'; readonly reason: string };

export interface ChainView {
  /** From the solidity node: only transactions in irreversible blocks. */
  readonly solidified: RawTransactionInfo | null;
  /** From the ordinary node: anything in a block, orphanable or not. */
  readonly seen: RawTransactionInfo | null;
}

export const MAX_PAYOUT_ATTEMPTS = 5;

export function reconcileVerdict(
  view: ChainView,
  signedTx: unknown,
  attempt: number,
  nowMs: number,
): ReconcileVerdict {
  if (view.solidified !== null) {
    const result = view.solidified.receipt?.result;

    // Money leaving has to be positively confirmed. A contract call in an
    // irreversible block always carries a result; one without is an anomaly
    // to wait out and look at, not a success to assume.
    if (result === 'SUCCESS') {
      return { kind: 'complete', feeSun: BigInt(view.solidified.fee ?? 0) };
    }
    if (result === undefined) {
      return { kind: 'wait', reason: 'solidified without a receipt result' };
    }
    return { kind: 'failed_on_chain', reason: `reverted on chain: ${result}` };
  }

  // In a block but not yet irreversible. It has landed; it is not dead, and it
  // is not final. Neither booking it nor rebuilding it is safe.
  if (view.seen !== null) {
    return { kind: 'wait', reason: 'in a block, not yet irreversible' };
  }

  // Unknown to both nodes. Only once the expiry has provably passed is it
  // certain the stored bytes will never land.
  if (!isPastExpiry(signedTx, nowMs)) {
    return { kind: 'wait', reason: 'not seen yet, still inside its expiry window' };
  }

  if (attempt >= MAX_PAYOUT_ATTEMPTS) {
    return { kind: 'give_up', reason: `expired without landing after ${attempt} attempts` };
  }
  return { kind: 'rebuild' };
}
