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

test('a payment may settle in one step when we were not watching', () => {
  // The indexer comes back after an outage and finds a transfer already
  // twenty blocks deep. Forcing this through the intermediate states would
  // delay settlement and emit webhooks for moments that have passed.
  //
  // This is not a skipped confirmation. Confirmation depth is checked against
  // the chain before any of these transitions is proposed; the table only
  // stops a payment moving backwards.
  assert.ok(canTransition('waiting', 'completed'));
  assert.ok(canTransition('detected', 'completed'));
});

test('a payment can never move backwards', () => {
  for (const state of ['waiting', 'detected', 'confirming', 'underpaid'] as const) {
    assert.equal(canTransition('completed', state), false, `completed -> ${state}`);
    assert.equal(canTransition('failed', state), false, `failed -> ${state}`);
    assert.equal(canTransition('overpaid', state), false, `overpaid -> ${state}`);
  }
  assert.equal(canTransition('confirming', 'waiting'), false);
  assert.equal(canTransition('confirming', 'detected'), false);
});

test('late money on an expired payment can still settle it', () => {
  // Leaving a customer's confirmed funds in limbo because a timer elapsed is
  // worse than settling late. The merchant is notified either way.
  assert.ok(canTransition('expired', 'completed'));
  assert.ok(canTransition('expired', 'underpaid'));
});

test('a top-up that overshoots is allowed', () => {
  assert.ok(canTransition('underpaid', 'overpaid'));
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
