import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseAmount, formatAmount } from './money.ts';
import {
  estimateCost,
  decideSweep,
  sunToAssetUnits,
  compareEnergyStrategies,
  SUN_PER_TRX,
  NO_HOLDINGS,
  DEFAULT_SWEEP_POLICY,
  type ResourcePrices,
} from './energy.ts';

const usdt = (text: string) => parseAmount(text, 'USDT');

/** Read from Nile on 2026-09-02 via /wallet/getchainparameters. */
const NILE: ResourcePrices = {
  energyFeeSun: 100n,
  bandwidthFeeSun: 1_000n,
  newAccountFeeSun: 1_000_000n,
};

/**
 * A higher energy price than either network currently charges.
 *
 * Mainnet voted 210 sun in 2024 and 100 sun as of this writing; Nile is also
 * at 100. The figure is kept here as a deliberately expensive case rather than
 * a claim about today's mainnet — the point of these tests is that the code
 * reads the price from the chain, so any constant in a test is an example and
 * never a source of truth.
 */
const EXPENSIVE: ResourcePrices = {
  energyFeeSun: 210n,
  bandwidthFeeSun: 1_000n,
  newAccountFeeSun: 1_000_000n,
};

/** A USDT transfer to an address that already holds USDT. */
const WARM_TRANSFER = { energyUnits: 30_000n, bandwidthBytes: 345n, activatesAccount: false };
/** The same transfer to an address holding none: the contract allocates storage. */
const COLD_TRANSFER = { energyUnits: 65_000n, bandwidthBytes: 345n, activatesAccount: false };

/** One TRX is worth 0.30 USDT in these tests. */
const TRX_AT_30_CENTS = usdt('0.30');

test('an account with nothing staked pays for everything it uses', () => {
  const cost = estimateCost(COLD_TRANSFER, EXPENSIVE, NO_HOLDINGS);

  assert.equal(cost.energyShortfall, 65_000n);
  assert.equal(cost.energyCostSun, 13_650_000n);        // 13.65 TRX
  assert.equal(cost.bandwidthCostSun, 345_000n);        // 0.345 TRX
  assert.equal(cost.totalSun, 13_995_000n);

  // Just under 14 TRX, which at $0.30 is roughly $4.20 — per sweep.
  assert.equal(cost.totalSun / SUN_PER_TRX, 13n);
});

test('delegated energy removes the largest part of the cost', () => {
  // This is the difference between staking TRX once and burning it forever.
  const withEnergy = estimateCost(COLD_TRANSFER, EXPENSIVE, {
    energyUnits: 65_000n,
    bandwidthBytes: 0n,
  });

  assert.equal(withEnergy.energyCostSun, 0n);
  assert.equal(withEnergy.totalSun, 345_000n); // bandwidth only
  // Forty times cheaper than paying for the energy.
  assert.ok(withEnergy.totalSun * 40n < 13_995_000n);
});

test('partial holdings only pay for the shortfall', () => {
  const cost = estimateCost(COLD_TRANSFER, EXPENSIVE, {
    energyUnits: 50_000n,
    bandwidthBytes: 600n,
  });

  assert.equal(cost.energyShortfall, 15_000n);
  assert.equal(cost.bandwidthShortfall, 0n);
  assert.equal(cost.bandwidthCostSun, 0n);
  assert.equal(cost.energyCostSun, 3_150_000n);
});

test('a first-ever transfer to a fresh address carries an activation fee', () => {
  const cost = estimateCost({ ...COLD_TRANSFER, activatesAccount: true }, EXPENSIVE);
  assert.equal(cost.activationCostSun, 1_000_000n); // 1 TRX
  assert.equal(cost.totalSun, 14_995_000n);
});

test('a warm destination costs less than half a cold one', () => {
  const warm = estimateCost(WARM_TRANSFER, EXPENSIVE);
  const cold = estimateCost(COLD_TRANSFER, EXPENSIVE);
  assert.ok(warm.totalSun * 2n < cold.totalSun);
});

test('the same transfer costs different amounts at different prices', () => {
  const cheap = estimateCost(COLD_TRANSFER, NILE);
  const dear = estimateCost(COLD_TRANSFER, EXPENSIVE);
  assert.ok(cheap.totalSun < dear.totalSun);
  // Hardcoding either figure would be wrong on the other network, and wrong
  // on both after the next governance vote.
});

test('sun converts into the asset being swept', () => {
  // 14 TRX at $0.30 is $4.20.
  assert.equal(formatAmount(sunToAssetUnits(14_000_000n, TRX_AT_30_CENTS), 'USDT'), '4.200000');
});

test('a healthy payment is worth sweeping', () => {
  const cost = estimateCost(COLD_TRANSFER, EXPENSIVE).totalSun;
  const decision = decideSweep(usdt('480.00'), cost, TRX_AT_30_CENTS);

  assert.equal(decision.verdict, 'sweep');
  assert.ok(decision.worthwhile);
  assert.equal(formatAmount(decision.costUnits, 'USDT'), '4.198500');
  assert.equal(formatAmount(decision.netUnits, 'USDT'), '475.801500');
});

test('dust is left where it is rather than swept at a loss', () => {
  // 0.50 USDT on an address that costs $4.20 to empty. Sweeping destroys
  // value; doing it automatically a thousand times a day destroys it at scale.
  const cost = estimateCost(COLD_TRANSFER, EXPENSIVE).totalSun;
  const decision = decideSweep(usdt('0.50'), cost, TRX_AT_30_CENTS);

  assert.equal(decision.verdict, 'costs_more_than_value');
  assert.equal(decision.worthwhile, false);
  assert.equal(decision.netUnits, 0n);
});

test('a payment the fee would eat most of is refused', () => {
  const cost = estimateCost(COLD_TRANSFER, EXPENSIVE).totalSun;
  // $4.20 out of $20 is 21% — above the 5% margin the policy allows.
  const decision = decideSweep(usdt('20.00'), cost, TRX_AT_30_CENTS);

  assert.equal(decision.verdict, 'costs_too_much');
  assert.match(decision.reason, /2099 bps of the amount, limit is 500/);
});

test('with delegated energy the same small payment becomes worth sweeping', () => {
  // The economics change with the strategy, not with the amount. An address
  // not worth emptying today is worth emptying once energy is staked.
  const burned = estimateCost(COLD_TRANSFER, EXPENSIVE).totalSun;
  const delegated = estimateCost(COLD_TRANSFER, EXPENSIVE, {
    energyUnits: 65_000n,
    bandwidthBytes: 0n,
  }).totalSun;

  assert.equal(decideSweep(usdt('20.00'), burned, TRX_AT_30_CENTS).worthwhile, false);
  assert.equal(decideSweep(usdt('20.00'), delegated, TRX_AT_30_CENTS).worthwhile, true);
});

test('the minimum balance is respected even when the margin looks fine', () => {
  const decision = decideSweep(usdt('0.90'), 1_000n, TRX_AT_30_CENTS);
  assert.equal(decision.verdict, 'below_minimum');
  // Default floor is 1 USDT.
  assert.equal(DEFAULT_SWEEP_POLICY.minValueUnits, usdt('1'));
});

test('a stricter policy refuses more', () => {
  const cost = estimateCost(WARM_TRANSFER, EXPENSIVE).totalSun;
  const relaxed = decideSweep(usdt('50.00'), cost, TRX_AT_30_CENTS, {
    maxFeeBps: 9_900n,
    minValueUnits: 0n,
  });
  const strict = decideSweep(usdt('50.00'), cost, TRX_AT_30_CENTS, {
    maxFeeBps: 1n,
    minValueUnits: 0n,
  });

  assert.ok(relaxed.worthwhile);
  assert.equal(strict.worthwhile, false);
});

test('the annual difference between burning and staking is the whole argument', () => {
  // A thousand sweeps a day at the expensive price.
  const { burnedSun, savedSun } = compareEnergyStrategies(1_000n, 65_000n, EXPENSIVE);
  const burnedTrx = burnedSun / SUN_PER_TRX;

  assert.equal(burnedTrx, 4_982_250n); // ~5 million TRX a year
  assert.equal(savedSun, burnedSun);   // staked TRX is returned when unstaked

  // At $0.30 that is nearly $1.5M — which is why the sweeper delegates energy
  // rather than paying for it.
  assert.ok(sunToAssetUnits(burnedSun, TRX_AT_30_CENTS) > usdt('1400000'));
});
