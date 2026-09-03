/**
 * What a TRON transaction costs, and whether it is worth making.
 *
 * TRON does not charge a simple fee. Every transaction consumes two resources:
 * ENERGY for contract execution (a USDT transfer is a contract call) and
 * BANDWIDTH for the bytes on the wire. An account gets a small free bandwidth
 * allowance daily and can obtain energy by staking TRX. Whatever it does not
 * have, it pays for by burning TRX at a price the network sets by governance
 * vote — which is why every price here is a parameter read from the chain and
 * none of them is a constant in this file.
 *
 * This matters more than it sounds. Sweeping funds off a deposit address is
 * the single largest running cost of a TRON payment operator: at a thousand
 * payments a day, the difference between burning TRX and staking for energy is
 * six figures a year.
 */

/** Live network prices, read from `/wallet/getchainparameters`. */
export interface ResourcePrices {
  /** Sun burned per unit of energy when the account has none staked. */
  readonly energyFeeSun: bigint;
  /** Sun burned per byte when the free bandwidth allowance is used up. */
  readonly bandwidthFeeSun: bigint;
  /** Sun charged to bring a never-used address into existence. */
  readonly newAccountFeeSun: bigint;
}

/** What a specific transaction will consume. */
export interface ResourceDemand {
  readonly energyUnits: bigint;
  readonly bandwidthBytes: bigint;
  /** True when the destination has never been activated on chain. */
  readonly activatesAccount: boolean;
}

/** What the sending account already has, so it need not be bought. */
export interface ResourceHoldings {
  readonly energyUnits: bigint;
  readonly bandwidthBytes: bigint;
}

export const NO_HOLDINGS: ResourceHoldings = Object.freeze({
  energyUnits: 0n,
  bandwidthBytes: 0n,
});

/**
 * Bandwidth every TRON account is given each day, free, whether or not it has
 * staked anything. Read from the chain as `getFreeNetLimit`; 600 bytes at the
 * time of writing.
 *
 * A TRC20 transfer is about 345 bytes, so an address that is swept once a day
 * pays nothing for bandwidth at all. Charging for it — as the first version of
 * this model did — overstates the cost of every sweep, and in the delegated
 * energy case it overstates it by the entire amount, because bandwidth was the
 * only thing left to pay for.
 */
export const FREE_BANDWIDTH_PER_DAY = 600n;

/**
 * What an account has to spend before buying anything: its free daily
 * bandwidth, plus whatever energy has been delegated to it.
 */
export function dailyHoldings(delegatedEnergy = 0n): ResourceHoldings {
  return Object.freeze({
    energyUnits: delegatedEnergy,
    bandwidthBytes: FREE_BANDWIDTH_PER_DAY,
  });
}

export interface CostBreakdown {
  /** Energy that must be paid for, after using what the account holds. */
  readonly energyShortfall: bigint;
  readonly bandwidthShortfall: bigint;
  readonly energyCostSun: bigint;
  readonly bandwidthCostSun: bigint;
  readonly activationCostSun: bigint;
  readonly totalSun: bigint;
}

const zeroFloor = (value: bigint): bigint => (value > 0n ? value : 0n);

/**
 * What this transaction will actually cost in TRX.
 *
 * Only the shortfall is charged. An account holding enough delegated energy
 * pays nothing for it, which is the whole point of staking rather than
 * burning — and the reason this function takes holdings rather than assuming
 * the worst.
 */
export function estimateCost(
  demand: ResourceDemand,
  prices: ResourcePrices,
  holdings: ResourceHoldings = dailyHoldings(),
): CostBreakdown {
  const energyShortfall = zeroFloor(demand.energyUnits - holdings.energyUnits);
  const bandwidthShortfall = zeroFloor(demand.bandwidthBytes - holdings.bandwidthBytes);

  const energyCostSun = energyShortfall * prices.energyFeeSun;
  const bandwidthCostSun = bandwidthShortfall * prices.bandwidthFeeSun;
  const activationCostSun = demand.activatesAccount ? prices.newAccountFeeSun : 0n;

  return Object.freeze({
    energyShortfall,
    bandwidthShortfall,
    energyCostSun,
    bandwidthCostSun,
    activationCostSun,
    totalSun: energyCostSun + bandwidthCostSun + activationCostSun,
  });
}

/** TRX is denominated in sun, six decimals, same as USDT. */
export const SUN_PER_TRX = 1_000_000n;

/**
 * Convert a TRX cost into the asset being swept, so the two can be compared.
 *
 * `trxPriceUnits` is the value of one TRX expressed in the asset's base units
 * — 300000 means one TRX is worth 0.30 USDT. It is a parameter because it is a
 * market price: a rate hardcoded today is wrong tomorrow, and a sweep decision
 * made against a stale rate either burns money or strands it.
 */
export function sunToAssetUnits(sun: bigint, trxPriceUnits: bigint): bigint {
  return (sun * trxPriceUnits) / SUN_PER_TRX;
}

// ---------------------------------------------------------------------------
// Is this sweep worth making?
// ---------------------------------------------------------------------------

export interface SweepPolicy {
  /**
   * The network fee may take at most this fraction of the amount being moved,
   * in basis points. 500 refuses any sweep whose fee exceeds 5% of the funds.
   *
   * Named for the fee rather than for the remainder on purpose: the first
   * version of this field was called minMarginBps and meant the opposite of
   * what its default implied, which let a fee of 95% through.
   */
  readonly maxFeeBps: bigint;
  /**
   * Never sweep less than this, whatever the margin works out to. Below some
   * amount the bookkeeping is worth more than the money.
   */
  readonly minValueUnits: bigint;
}

export const DEFAULT_SWEEP_POLICY: SweepPolicy = Object.freeze({
  maxFeeBps: 500n,
  minValueUnits: 1_000000n, // 1 USDT
});

export type SweepVerdict = 'sweep' | 'below_minimum' | 'costs_too_much' | 'costs_more_than_value';

export interface SweepDecision {
  readonly verdict: SweepVerdict;
  readonly worthwhile: boolean;
  readonly valueUnits: bigint;
  readonly costUnits: bigint;
  /** What actually arrives after the network takes its share. */
  readonly netUnits: bigint;
  readonly reason: string;
}

/**
 * Decide whether to move funds off a deposit address.
 *
 * The case this exists for: a 0.50 USDT payment sitting on an address that
 * costs 1.30 USDT of TRX to empty. Sweeping it destroys value, and doing so
 * automatically a thousand times a day destroys it at scale. Such addresses
 * are left alone until either the balance grows or energy gets cheap enough,
 * both of which this function re-evaluates every time it is asked.
 *
 * Nothing here is irreversible: an address that is not worth sweeping today
 * still holds its funds tomorrow.
 */
export function decideSweep(
  valueUnits: bigint,
  costSun: bigint,
  trxPriceUnits: bigint,
  policy: SweepPolicy = DEFAULT_SWEEP_POLICY,
): SweepDecision {
  const costUnits = sunToAssetUnits(costSun, trxPriceUnits);
  const netUnits = valueUnits - costUnits;

  const decide = (verdict: SweepVerdict, reason: string): SweepDecision =>
    Object.freeze({
      verdict,
      worthwhile: verdict === 'sweep',
      valueUnits,
      costUnits,
      netUnits: netUnits > 0n ? netUnits : 0n,
      reason,
    });

  if (costUnits >= valueUnits) {
    return decide(
      'costs_more_than_value',
      'The network fee is at least the amount being moved',
    );
  }

  if (valueUnits < policy.minValueUnits) {
    return decide('below_minimum', 'Balance is under the minimum worth moving');
  }

  const feeBps = (costUnits * 10_000n) / valueUnits;
  if (feeBps > policy.maxFeeBps) {
    return decide(
      'costs_too_much',
      `Fee would take ${feeBps.toString()} bps of the amount, limit is ${policy.maxFeeBps.toString()}`,
    );
  }

  return decide('sweep', 'Worth moving');
}

/**
 * What burning TRX costs against what staking for energy costs, over a period.
 *
 * Included because the difference decides the architecture rather than being a
 * tuning detail, and because it is easy to build a working sweeper that
 * quietly burns six figures a year.
 */
export function compareEnergyStrategies(
  sweepsPerDay: bigint,
  energyPerSweep: bigint,
  prices: ResourcePrices,
  days: bigint = 365n,
): { burnedSun: bigint; stakedSun: bigint; savedSun: bigint } {
  const burnedSun = sweepsPerDay * days * energyPerSweep * prices.energyFeeSun;
  // Staked TRX is returned when unstaked, so the running cost of energy
  // obtained by staking is zero — only the capital is tied up.
  const stakedSun = 0n;
  return { burnedSun, stakedSun, savedSun: burnedSun - stakedSun };
}
