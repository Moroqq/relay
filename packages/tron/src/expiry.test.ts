import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { transactionExpiry, isPastExpiry, EXPIRY_MARGIN_MS } from './expiry.ts';

/** A transaction a real Nile node built, captured in the sweeper's tests. */
const REAL = JSON.parse(
  readFileSync(new URL('../../../services/sweeper/src/fixture-transaction.json', import.meta.url), 'utf8'),
);

test('the expiry is read from a real transaction', () => {
  assert.equal(transactionExpiry(REAL), 1788424836000);
});

test('a transaction inside its window is alive', () => {
  const expiry = transactionExpiry(REAL)!;
  assert.equal(isPastExpiry(REAL, expiry - 30_000), false);
  assert.equal(isPastExpiry(REAL, expiry), false);
});

test('just past expiry is still alive — a lagging node may not have reported it', () => {
  const expiry = transactionExpiry(REAL)!;
  assert.equal(isPastExpiry(REAL, expiry + 60_000), false);
});

test('past expiry plus the margin is dead and safe to rebuild', () => {
  const expiry = transactionExpiry(REAL)!;
  assert.equal(isPastExpiry(REAL, expiry + EXPIRY_MARGIN_MS + 1), true);
});

test('when the expiry cannot be read, the answer to "may I rebuild" is no', () => {
  // Rebuilding a transaction that might still land is how money is sent twice.
  const far = Date.now() + 10 ** 12;
  for (const tx of [null, undefined, {}, { raw_data: {} }, { raw_data: { expiration: 'soon' } }, 'text']) {
    assert.equal(isPastExpiry(tx, far), false, JSON.stringify(tx));
    assert.equal(transactionExpiry(tx), null);
  }
});
