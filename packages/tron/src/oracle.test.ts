import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  decodeRoundData,
  decodeString,
  decodeUint,
  priceFromRound,
  USDT_TRX_DESCRIPTION,
  DEFAULT_MAX_PRICE_AGE_SECONDS,
  OracleError,
} from './oracle.ts';

/** The mainnet USDT/TRX proxy's answers, captured verbatim. */
const REAL = JSON.parse(readFileSync(new URL('./fixture-oracle-usdt-trx.json', import.meta.url), 'utf8'));
const ROUND = decodeRoundData(REAL['latestRoundData()']);
const DECIMALS = Number(decodeUint(REAL['decimals()']));
const UPDATED = Number(ROUND.updatedAt);

test('the captured feed describes itself as USDT/TRX with six decimals', () => {
  assert.equal(decodeString(REAL['description()']), USDT_TRX_DESCRIPTION);
  assert.equal(DECIMALS, 6);
});

test('the captured round decodes to a sane answer', () => {
  assert.equal(ROUND.answer, 2_976_801n); // one USDT bought 2.976801 TRX
  assert.equal(ROUND.answeredInRound, ROUND.roundId);
  assert.equal(new Date(UPDATED * 1000).toISOString(), '2026-09-16T17:21:15.000Z');
});

test('the price is the inverse, in USDT base units, rounded up', () => {
  // 10^12 / 2,976,801 = 335,931.07... -> 335,932. Rounding up overstates what a
  // TRX fee costs in USDT, which refuses a marginal sweep rather than
  // approving one.
  const verdict = priceFromRound(ROUND, { nowSeconds: UPDATED + 60, decimals: DECIMALS });
  assert.deepEqual(verdict, { ok: true, trxPriceUnits: 335_932n, ageSeconds: 60 });
});

test('a day-old price is normal, because the heartbeat is a day', () => {
  // WINkLink only pushes early on a 1% move. A limit shorter than its 24h
  // heartbeat would refuse the oracle whenever the market is calm.
  const aDay = priceFromRound(ROUND, { nowSeconds: UPDATED + 24 * 3600, decimals: DECIMALS });
  assert.equal(aDay.ok, true);
  assert.ok(DEFAULT_MAX_PRICE_AGE_SECONDS > 24 * 3600);
});

test('a price older than the limit is refused', () => {
  const late = priceFromRound(ROUND, { nowSeconds: UPDATED + DEFAULT_MAX_PRICE_AGE_SECONDS + 1, decimals: DECIMALS });
  assert.equal(late.ok, false);
  assert.match(late.ok ? '' : late.reason, /old, limit is 26h/);
});

test('a price from the future is refused, but a few seconds of skew is not', () => {
  assert.equal(priceFromRound(ROUND, { nowSeconds: UPDATED - 3600, decimals: DECIMALS }).ok, false);
  assert.equal(priceFromRound(ROUND, { nowSeconds: UPDATED - 30, decimals: DECIMALS }).ok, true);
});

test('a zero, negative or never-updated answer is refused', () => {
  const now = UPDATED + 60;
  for (const round of [{ ...ROUND, answer: 0n }, { ...ROUND, answer: -5n }, { ...ROUND, updatedAt: 0n }]) {
    assert.equal(priceFromRound(round, { nowSeconds: now, decimals: DECIMALS }).ok, false);
  }
});

test('a value carried over from an earlier round is refused as stale', () => {
  const carried = { ...ROUND, answeredInRound: ROUND.roundId - 1n };
  assert.equal(priceFromRound(carried, { nowSeconds: UPDATED + 60, decimals: DECIMALS }).ok, false);
});

test('a decimals mistake lands orders of magnitude out and is refused', () => {
  assert.equal(priceFromRound(ROUND, { nowSeconds: UPDATED + 60, decimals: 18 }).ok, false);
  assert.equal(priceFromRound(ROUND, { nowSeconds: UPDATED + 60, decimals: 0 }).ok, false);
});

test('malformed return data is an error, not a price', () => {
  assert.throws(() => decodeRoundData(''), OracleError);
  assert.throws(() => decodeRoundData('00'.repeat(100)), OracleError);
  assert.throws(() => decodeUint(''), OracleError);
  assert.throws(() => decodeString('00'), OracleError);
});

test('a negative int256 answer decodes as negative, not as a huge positive', () => {
  const one = '0'.repeat(63) + '1';
  assert.equal(decodeRoundData(one + 'f'.repeat(64) + one + one + one).answer, -1n);
});
