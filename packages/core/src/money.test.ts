import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseAmount, formatAmount, mulBps, MoneyError } from './money.ts';

test('parseAmount converts decimal strings to base units', () => {
  assert.equal(parseAmount('480', 'USDT'), 480_000000n);
  assert.equal(parseAmount('288.4', 'USDT'), 288_400000n);
  assert.equal(parseAmount('0.000001', 'USDT'), 1n);
  assert.equal(parseAmount('0', 'USDT'), 0n);
  assert.equal(parseAmount('  15000.00  ', 'USDT'), 15000_000000n);
});

test('parseAmount rejects anything ambiguous', () => {
  for (const bad of ['1e3', '-5', '480.', '.5', '1,000', '', 'abc', '0x10', 'Infinity']) {
    assert.throws(() => parseAmount(bad, 'USDT'), MoneyError, `should reject ${JSON.stringify(bad)}`);
  }
});

test('parseAmount rejects precision the asset cannot hold', () => {
  // 7 decimals on a 6-decimal asset would silently truncate somebody's money.
  assert.throws(() => parseAmount('0.0000001', 'USDT'), MoneyError);
});

test('formatAmount round-trips through parseAmount', () => {
  for (const text of ['480.000000', '288.400000', '0.000001', '1204880.000000']) {
    assert.equal(formatAmount(parseAmount(text, 'USDT'), 'USDT'), text);
  }
});

test('formatAmount can trim for display only', () => {
  assert.equal(formatAmount(480_000000n, 'USDT'), '480.000000');
  assert.equal(formatAmount(480_000000n, 'USDT', { trimTrailingZeros: true }), '480');
  assert.equal(formatAmount(288_400000n, 'USDT', { trimTrailingZeros: true }), '288.4');
});

test('float arithmetic would have been wrong here', () => {
  // The canonical demonstration: 0.1 + 0.2 !== 0.3 in float, but is exact here.
  const sum = parseAmount('0.1', 'USDT') + parseAmount('0.2', 'USDT');
  assert.equal(sum, parseAmount('0.3', 'USDT'));
  assert.equal(formatAmount(sum, 'USDT', { trimTrailingZeros: true }), '0.3');
  assert.notEqual(0.1 + 0.2, 0.3); // ...whereas the naive version is not
});

test('mulBps computes fees and rounds half up', () => {
  assert.equal(mulBps(480_000000n, 100n), 4_800000n);   // 1% of 480 = 4.80
  assert.equal(mulBps(15000_000000n, 50n), 75_000000n); // 0.5% of 15000 = 75
  assert.equal(mulBps(1n, 5000n), 1n);                  // 50% of 1 unit rounds up
  assert.equal(mulBps(1n, 4999n), 0n);                  // just under half rounds down
  assert.equal(mulBps(0n, 100n), 0n);
});

test('a large amount stays exact where a float would drift', () => {
  // 90,071,992.547409 USDT is past the point where doubles lose the last digit.
  const units = parseAmount('90071992.547409', 'USDT');
  assert.equal(formatAmount(units, 'USDT'), '90071992.547409');
});
