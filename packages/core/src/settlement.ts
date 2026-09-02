/**
 * Deciding what actually happened when money lands.
 *
 * A customer told to send 480.00 USDT will sometimes send 479.98, because
 * their wallet skimmed a fee, or 480.02 because they fat-fingered it. Treating
 * either as a failure creates support tickets and refunds; treating either as
 * exact creates a slow leak. So the boundary is an explicit, configurable
 * policy rather than an accident of whichever comparison someone typed first.
 */

import { type Asset, mulBps } from './money.ts';

export type ReceiptOutcome = 'exact' | 'under' | 'over';

export interface TolerancePolicy {
  /**
   * How far below the expected amount still counts as paid in full, as basis
   * points of the expected amount (1 bp = 0.01%).
   */
  readonly underBps: bigint;
  /**
   * A floor for the tolerance in base units, so that small payments get a
   * usable allowance too. On a 10 USDT invoice, 50 bps is only 0.005 USDT —
   * narrower than the rounding of most wallets.
   */
  readonly underFloorUnits: bigint;
  /**
   * How far above the expected amount is treated as a rounding artefact rather
   * than a genuine overpayment needing a refund decision.
   */
  readonly overBps: bigint;
  readonly overFloorUnits: bigint;
}

/**
 * Defaults: accept 0.5% or 0.10 USDT short (whichever is more generous),
 * and absorb 0.5% or 0.10 USDT over as noise.
 *
 * These are a starting point, not a pricing decision — every merchant should
 * be able to override them per project once the console exists.
 */
export const DEFAULT_TOLERANCE: TolerancePolicy = Object.freeze({
  underBps: 50n,
  underFloorUnits: 100_000n, // 0.10 USDT at 6 decimals
  overBps: 50n,
  overFloorUnits: 100_000n,
});

function toleranceBand(
  expected: bigint,
  bps: bigint,
  floorUnits: bigint,
): bigint {
  const proportional = mulBps(expected, bps);
  return proportional > floorUnits ? proportional : floorUnits;
}

/**
 * Classify the total received against what was expected.
 *
 * Takes the RUNNING TOTAL for the payment, not a single transfer — a customer
 * who pays in two halves has paid in full, and comparing one transfer at a
 * time would strand them in `underpaid` forever.
 */
export function classifyReceipt(
  expected: bigint,
  receivedTotal: bigint,
  policy: TolerancePolicy = DEFAULT_TOLERANCE,
): ReceiptOutcome {
  const underBand = toleranceBand(expected, policy.underBps, policy.underFloorUnits);
  const overBand = toleranceBand(expected, policy.overBps, policy.overFloorUnits);

  if (receivedTotal < expected - underBand) return 'under';
  if (receivedTotal > expected + overBand) return 'over';
  return 'exact';
}

// ---------------------------------------------------------------------------
// Splitting the money
// ---------------------------------------------------------------------------

export interface FeeSchedule {
  /** Percentage cut, in basis points. 100n = 1%. */
  readonly rateBps: bigint;
  /** Flat cut per payment, in base units. */
  readonly flatUnits: bigint;
}

export interface Split {
  readonly asset: Asset;
  /** What the customer actually sent. */
  readonly grossUnits: bigint;
  /** Relay's cut. */
  readonly feeUnits: bigint;
  /** What the merchant is owed. */
  readonly netUnits: bigint;
}

export class SettlementError extends Error {
  override readonly name = 'SettlementError';
}

/**
 * Split a received amount into the merchant's share and ours.
 *
 * The fee is capped at the gross so a flat fee larger than a tiny payment can
 * never produce a negative payout. That case is a pricing mistake and the
 * caller should surface it, but it must never become a negative ledger entry.
 */
export function splitPayment(
  grossUnits: bigint,
  asset: Asset,
  schedule: FeeSchedule,
): Split {
  if (grossUnits < 0n) throw new SettlementError(`Gross cannot be negative: ${grossUnits}`);

  const uncapped = mulBps(grossUnits, schedule.rateBps) + schedule.flatUnits;
  const feeUnits = uncapped > grossUnits ? grossUnits : uncapped;

  return Object.freeze({
    asset,
    grossUnits,
    feeUnits,
    netUnits: grossUnits - feeUnits,
  });
}
