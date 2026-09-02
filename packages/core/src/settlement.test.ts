import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseAmount } from './money.ts';
import { classifyReceipt, splitPayment, DEFAULT_TOLERANCE } from './settlement.ts';

const usdt = (text: string) => parseAmount(text, 'USDT');

test('an exact payment is exact', () => {
  assert.equal(classifyReceipt(usdt('480'), usdt('480')), 'exact');
});

test('a wallet fee shaved off the top is still paid in full', () => {
  // Customer told to send 480, their wallet sent 479.95. That is 0.01% short —
  // inside tolerance, and bouncing it would create a support ticket.
  assert.equal(classifyReceipt(usdt('480'), usdt('479.95')), 'exact');
});

test('a real shortfall is flagged', () => {
  // The PAY_2D8C77 scenario from the design: expected 300, received 288.40.
  assert.equal(classifyReceipt(usdt('300'), usdt('288.4')), 'under');
});

test('a real overpayment is flagged', () => {
  // The PAY_D19045 scenario: expected 900, received 912.
  assert.equal(classifyReceipt(usdt('900'), usdt('912')), 'over');
});

test('small invoices get a usable absolute allowance', () => {
  // 0.5% of 10 USDT is only 0.05 — narrower than most wallets round. The
  // 0.10 floor is what keeps ten-dollar invoices from failing constantly.
  assert.equal(classifyReceipt(usdt('10'), usdt('9.92')), 'exact');
  assert.equal(classifyReceipt(usdt('10'), usdt('9.80')), 'under');
});

test('large invoices scale their allowance proportionally', () => {
  // 0.5% of 15000 = 75.
  assert.equal(classifyReceipt(usdt('15000'), usdt('14930')), 'exact');
  assert.equal(classifyReceipt(usdt('15000'), usdt('14900')), 'under');
});

test('a payment made in two transfers settles on the running total', () => {
  const expected = usdt('480');
  let running = usdt('200');
  assert.equal(classifyReceipt(expected, running), 'under');

  running += usdt('280');
  assert.equal(classifyReceipt(expected, running), 'exact');
});

test('zero received on an open payment is an underpayment, not an error', () => {
  assert.equal(classifyReceipt(usdt('480'), 0n), 'under');
});

test('tolerance policy is configurable per merchant', () => {
  const strict = { ...DEFAULT_TOLERANCE, underBps: 0n, underFloorUnits: 0n };
  assert.equal(classifyReceipt(usdt('480'), usdt('479.99'), strict), 'under');
  assert.equal(classifyReceipt(usdt('480'), usdt('480'), strict), 'exact');
});

test('splitPayment separates the merchant share from the fee', () => {
  const split = splitPayment(usdt('480'), 'USDT', { rateBps: 100n, flatUnits: 0n });
  assert.equal(split.grossUnits, usdt('480'));
  assert.equal(split.feeUnits, usdt('4.8'));
  assert.equal(split.netUnits, usdt('475.2'));
});

test('the split always adds back up to the gross', () => {
  // The invariant the ledger depends on: nothing is created, nothing vanishes.
  for (const amount of ['0.000001', '1', '9.99', '480', '15000', '1204880.123456']) {
    const split = splitPayment(usdt(amount), 'USDT', { rateBps: 137n, flatUnits: usdt('1.1') });
    assert.equal(split.feeUnits + split.netUnits, split.grossUnits, `broken for ${amount}`);
  }
});

test('a flat fee larger than the payment can never owe the merchant a negative', () => {
  const split = splitPayment(usdt('0.50'), 'USDT', { rateBps: 100n, flatUnits: usdt('1.10') });
  assert.equal(split.netUnits, 0n);
  assert.equal(split.feeUnits, usdt('0.50'));
  assert.ok(split.netUnits >= 0n);
});
