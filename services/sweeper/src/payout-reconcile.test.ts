import { test } from 'node:test';
import assert from 'node:assert/strict';

import { EXPIRY_MARGIN_MS } from '@relay/tron';

import { reconcileVerdict, MAX_PAYOUT_ATTEMPTS } from './payout-reconcile.ts';

const EXPIRY = 1_800_000_000_000;
const SIGNED = { txID: 'ab'.repeat(32), raw_data: { expiration: EXPIRY } };

const BEFORE = EXPIRY - 10_000;
const DEAD = EXPIRY + EXPIRY_MARGIN_MS + 1;

const ok = { id: 'x', fee: 163_020, receipt: { result: 'SUCCESS' } };
const reverted = { id: 'x', fee: 2_000_000, receipt: { result: 'REVERT' } };

test('irreversible and successful: book it, with the fee the network charged', () => {
  assert.deepEqual(
    reconcileVerdict({ solidified: ok, seen: ok }, SIGNED, 1, BEFORE),
    { kind: 'complete', feeSun: 163_020n },
  );
});

test('irreversible and reverted: failed, never booked as paid', () => {
  // The fee is gone and nothing moved. Booking it as paid would show the
  // merchant money they did not receive.
  const verdict = reconcileVerdict({ solidified: reverted, seen: reverted }, SIGNED, 1, BEFORE);
  assert.equal(verdict.kind, 'failed_on_chain');
});

test('in a block but not irreversible: wait — neither book nor rebuild', () => {
  // Booking could record a payment a reorg then erases. Rebuilding would send
  // a second transfer while the first is sitting in a block.
  for (const now of [BEFORE, DEAD]) {
    assert.equal(reconcileVerdict({ solidified: null, seen: ok }, SIGNED, 1, now).kind, 'wait');
  }
});

test('unseen but still inside its expiry window: wait', () => {
  // It may simply not have propagated yet.
  assert.equal(reconcileVerdict({ solidified: null, seen: null }, SIGNED, 1, BEFORE).kind, 'wait');
});

test('unseen and provably expired: rebuild', () => {
  assert.equal(reconcileVerdict({ solidified: null, seen: null }, SIGNED, 1, DEAD).kind, 'rebuild');
});

test('unseen, expired, attempts exhausted: give up and hand to a person', () => {
  const verdict = reconcileVerdict({ solidified: null, seen: null }, SIGNED, MAX_PAYOUT_ATTEMPTS, DEAD);
  assert.equal(verdict.kind, 'give_up');
});

test('an unreadable stored transaction is never rebuilt, however much time passes', () => {
  // Without an expiry there is no moment after which rebuilding is provably
  // safe, so the answer stays no.
  const far = DEAD * 10;
  for (const tx of [null, {}, { raw_data: {} }]) {
    assert.equal(reconcileVerdict({ solidified: null, seen: null }, tx, 1, far).kind, 'wait');
  }
});

test('a solidified receipt with no result is an anomaly to wait on, not a success', () => {
  const odd = { id: 'x', fee: 0, receipt: {} };
  assert.equal(reconcileVerdict({ solidified: odd, seen: odd }, SIGNED, 1, BEFORE).kind, 'wait');
});
