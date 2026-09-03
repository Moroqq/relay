import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseAmount, formatAmount } from './money.ts';
import {
  estimateCost,
  decideSweep,
  sunToAssetUnits,
  compareEnergyStrategies,
  dailyHoldings,
  SUN_PER_TRX,
  FREE_BANDWIDTH_PER_DAY,
  NO_HOLDINGS,
  DEFAULT_SWEEP_POLICY,
  type ResourcePrices,
} from './energy.ts';

const usdt = (text: string) => parseAmount(text, 'USDT');

/**
 * A deliberately expensive price, not a claim about any live network.
 * Mainnet voted 210 sun in 2024 and charges 100 as of this writing; Nile is
 * also at 100. The code reads the price from the chain precisely because it is
 * a governance parameter, so no constant here is a source of truth.
 */
const EXPENSIVE: ResourcePrices = {
  energyFeeSun: 210n,
  bandwidthFeeSun: 1_000n,
  newAccountFeeSun: 1_000_000n,
};

/**
 * Measured on mainnet by simulating real USDT transfers.
 *
 * The difference is one storage write: crediting an address that already holds
 * USDT updates a slot, crediting an empty one allocates a new slot. That single
 * distinction doubles the cost of a transfer.
 */
const WARM_TRANSFER = { energyUnits: 64_285n, bandwidthBytes: 345n, activatesAccount: false };
const COLD_TRANSFER = { energyUnits: 130_285n, bandwidthBytes: 345n, activatesAccount: false };

/** One TRX is worth 0.30 USDT in these tests. */
const TRX_AT_30_CENTS = usdt('0.30');

test('an empty recipient costs about twice a funded one', () => {
  const warm = estimateCost(WARM_TRANSFER, EXPENSIVE);
  const cold = estimateCost(COLD_TRANSFER, EXPENSIVE);
  assert.ok(cold.totalSun > (warm.totalSun * 19n) / 10n);
  assert.ok(cold.totalSun < warm.totalSun * 21n / 10n);
});

test('bandwidth is free for an address swept once a day', () => {
  // Every account gets 600 bytes a day whether or not it stakes anything, and
  // a TRC20 transfer is about 345. Charging for bandwidth overstates the cost
  // of every sweep — and in the delegated case, overstates it entirely.
  assert.ok(FREE_BANDWIDTH_PER_DAY > WARM_TRANSFER.bandwidthBytes);

  const cost = estimateCost(WARM_TRANSFER, EXPENSIVE);
  assert.equal(cost.bandwidthShortfall, 0n);
  assert.equal(cost.bandwidthCostSun, 0n);
});

test('an account with literally nothing pays for bandwidth too', () => {
  // NO_HOLDINGS is the pathological case, kept so the model can express it.
  const cost = estimateCost(COLD_TRANSFER, EXPENSIVE, NO_HOLDINGS);
  assert.equal(cost.bandwidthCostSun, 345_000n);
  assert.equal(cost.energyCostSun, 27_359_850n);
  assert.equal(cost.totalSun, 27_704_850n);
});

test('delegated energy plus free bandwidth costs nothing at all', () => {
  // The whole argument for staking, in one assertion: a sweep from an address
  // with delegated energy is free. Not cheaper — free.
  const cost = estimateCost(COLD_TRANSFER, EXPENSIVE, dailyHoldings(COLD_TRANSFER.energyUnits));
  assert.equal(cost.energyCostSun, 0n);
  assert.equal(cost.bandwidthCostSun, 0n);
  assert.equal(cost.totalSun, 0n);
});

test('partial holdings only pay for the shortfall', () => {
  const cost = estimateCost(COLD_TRANSFER, EXPENSIVE, dailyHoldings(50_000n));
  assert.equal(cost.energyShortfall, 80_285n);
  assert.equal(cost.energyCostSun, 16_859_850n);
  assert.equal(cost.bandwidthCostSun, 0n);
});

test('a first-ever transfer to a never-used address carries an activation fee', () => {
  const cost = estimateCost({ ...COLD_TRANSFER, activatesAccount: true }, EXPENSIVE);
  assert.equal(cost.activationCostSun, 1_000_000n); // 1 TRX
  assert.equal(cost.totalSun, 28_359_850n);
});

test('the same transfer costs different amounts at different prices', () => {
  const cheap = estimateCost(COLD_TRANSFER, { ...EXPENSIVE, energyFeeSun: 100n });
  const dear = estimateCost(COLD_TRANSFER, EXPENSIVE);
  assert.ok(cheap.totalSun < dear.totalSun);
});

test('sun converts into the asset being swept', () => {
  assert.equal(formatAmount(sunToAssetUnits(14_000_000n, TRX_AT_30_CENTS), 'USDT'), '4.200000');
});

test('a healthy payment is worth sweeping', () => {
  const cost = estimateCost(COLD_TRANSFER, EXPENSIVE).totalSun;
  const decision = decideSweep(usdt('480.00'), cost, TRX_AT_30_CENTS);

  assert.equal(decision.verdict, 'sweep');
  assert.equal(formatAmount(decision.costUnits, 'USDT'), '8.207955');
  assert.equal(formatAmount(decision.netUnits, 'USDT'), '471.792045');
});

test('dust is left where it is rather than swept at a loss', () => {
  // 0.50 USDT on an address costing 8.20 USDT to empty. Sweeping destroys
  // value; doing it automatically a thousand times a day destroys it at scale.
  const cost = estimateCost(COLD_TRANSFER, EXPENSIVE).totalSun;
  const decision = decideSweep(usdt('0.50'), cost, TRX_AT_30_CENTS);

  assert.equal(decision.verdict, 'costs_more_than_value');
  assert.equal(decision.netUnits, 0n);
});

test('a payment the fee would eat too much of is refused', () => {
  const cost = estimateCost(COLD_TRANSFER, EXPENSIVE).totalSun;
  const decision = decideSweep(usdt('20.00'), cost, TRX_AT_30_CENTS);

  assert.equal(decision.verdict, 'costs_too_much');
  assert.match(decision.reason, /4103 bps of the amount, limit is 500/);
});

test('with delegated energy that same payment becomes worth sweeping', () => {
  // The economics change with the strategy, not with the amount.
  const burned = estimateCost(COLD_TRANSFER, EXPENSIVE).totalSun;
  const delegated = estimateCost(
    COLD_TRANSFER,
    EXPENSIVE,
    dailyHoldings(COLD_TRANSFER.energyUnits),
  ).totalSun;

  assert.equal(decideSweep(usdt('20.00'), burned, TRX_AT_30_CENTS).worthwhile, false);
  assert.equal(decideSweep(usdt('20.00'), delegated, TRX_AT_30_CENTS).worthwhile, true);
});

test('a warm recipient makes a sweep worth making that a cold one does not', () => {
  // Reason enough to keep a merchant's payout address funded: the same payment
  // is worth moving to an address that already holds USDT and not to one that
  // does not.
  const warm = estimateCost(WARM_TRANSFER, EXPENSIVE).totalSun;
  const cold = estimateCost(COLD_TRANSFER, EXPENSIVE).totalSun;

  // At 120 USDT the warm fee is 337 bps and the cold one 683, either side of
  // the 500 bps limit. Above 165 both pass and below 81 both fail; the
  // distinction only bites in the band between.
  assert.equal(decideSweep(usdt('120.00'), warm, TRX_AT_30_CENTS).worthwhile, true);
  assert.equal(decideSweep(usdt('120.00'), cold, TRX_AT_30_CENTS).worthwhile, false);
});

test('the minimum balance is respected even when the fee looks fine', () => {
  const decision = decideSweep(usdt('0.90'), 1_000n, TRX_AT_30_CENTS);
  assert.equal(decision.verdict, 'below_minimum');
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
  const { burnedSun, savedSun } = compareEnergyStrategies(
    1_000n,
    WARM_TRANSFER.energyUnits,
    EXPENSIVE,
  );

  // Staked TRX is returned when unstaked, so energy obtained by staking has no
  // running cost — only tied-up capital.
  assert.equal(savedSun, burnedSun);
  assert.ok(burnedSun / SUN_PER_TRX > 4_000_000n, 'over four million TRX a year burned');
  assert.ok(sunToAssetUnits(burnedSun, TRX_AT_30_CENTS) > usdt('1400000'));
});
