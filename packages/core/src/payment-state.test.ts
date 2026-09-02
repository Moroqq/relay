import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  canTransition,
  assertTransition,
  isTerminal,
  isSettled,
  displayState,
  PaymentTransitionError,
} from './payment-state.ts';

test('the happy path walks all the way to completed', () => {
  assert.ok(canTransition('waiting', 'detected'));
  assert.ok(canTransition('detected', 'confirming'));
  assert.ok(canTransition('confirming', 'completed'));
});

test('a payment can never skip confirmations', () => {
  // Straight from "we saw something" to "it is settled" would mean paying out
  // on a transfer that can still be orphaned.
  assert.equal(canTransition('detected', 'completed'), false);
  assert.equal(canTransition('waiting', 'completed'), false);
});

test('settled money cannot be walked back', () => {
  assert.ok(isTerminal('completed'));
  assert.ok(isTerminal('failed'));
  assert.equal(canTransition('completed', 'failed'), false);
  assert.equal(canTransition('completed', 'confirming'), false);
});

test('an underpaid payment can be topped up', () => {
  assert.ok(canTransition('underpaid', 'confirming'));
  assert.ok(canTransition('underpaid', 'completed'));
});

test('money arriving after the window closed is handled, not lost', () => {
  // Late payments are routine. If `expired` were terminal, this money would
  // sit on a deposit address with no payment claiming it.
  assert.ok(canTransition('expired', 'detected'));
});

test('assertTransition rejects an illegal move loudly', () => {
  assert.throws(() => assertTransition('completed', 'waiting'), PaymentTransitionError);
  assert.doesNotThrow(() => assertTransition('waiting', 'detected'));
});

test('settled means the funds are ours to forward', () => {
  assert.ok(isSettled('completed'));
  assert.ok(isSettled('overpaid'));
  assert.equal(isSettled('confirming'), false);
  assert.equal(isSettled('underpaid'), false);
});

test('a failed webhook never un-settles the payment', () => {
  // The PAY_9C4D18 scenario: on-chain done, merchant endpoint returning 502.
  // The console shows one label; the money stays settled underneath.
  assert.equal(displayState('completed', 'failed'), 'webhook_failed');
  assert.ok(isSettled('completed'));
});

test('a still-confirming payment is never labelled webhook_failed', () => {
  assert.equal(displayState('confirming', 'failed'), 'confirming');
});
