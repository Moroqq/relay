import { test } from 'node:test';
import assert from 'node:assert/strict';

import { interpretEstimate, decodeHexMessage } from './estimate.ts';

/**
 * Captured from Nile: a USDT transfer of 475.2 attempted from an address that
 * holds nothing. Kept verbatim because the shape of this reply is the whole
 * point — it is what a failing call actually looks like.
 */
const REVERTED = {
  result: { result: true, message: '524556455254206f70636f6465206578656375746564' },
  energy_used: 1984,
  constant_result: [''],
};

/** What a transfer that would go through looks like: bool true, real energy. */
const WOULD_SUCCEED = {
  result: { result: true },
  energy_used: 64_895,
  constant_result: ['0'.repeat(63) + '1'],
};

test('a reverting transfer is not reported as successful', () => {
  // The trap this whole module exists for. `result.result` is true here: it
  // means the simulation ran, not that the transfer would work. Reading only
  // that boolean makes the sweeper broadcast doomed transactions and burn the
  // fee limit on each one.
  const estimate = interpretEstimate(REVERTED);

  assert.equal(REVERTED.result.result, true, 'the node really does say true');
  assert.equal(estimate.willSucceed, false);
  assert.equal(estimate.message, 'REVERT opcode executed');
});

test('a transfer that would go through is recognised', () => {
  const estimate = interpretEstimate(WOULD_SUCCEED);
  assert.equal(estimate.willSucceed, true);
  assert.equal(estimate.energyUsed, 64_895n);
  assert.equal(estimate.message, undefined);
});

test('a reverted call reports implausibly little energy', () => {
  // 1,984 energy against roughly 65,000 for a real transfer. The number alone
  // says the call stopped early.
  const estimate = interpretEstimate(REVERTED);
  assert.equal(estimate.energyUsed, 1_984n);
  assert.ok(estimate.energyUsed * 30n < interpretEstimate(WOULD_SUCCEED).energyUsed);
});

test('a contract returning false is not a success', () => {
  // Some TRC20 tokens return false instead of reverting. Both must be caught.
  const returnsFalse = {
    result: { result: true },
    energy_used: 30_000,
    constant_result: ['0'.repeat(64)],
  };
  const estimate = interpretEstimate(returnsFalse);
  assert.equal(estimate.willSucceed, false);
  assert.match(estimate.message ?? '', /contract returned/);
});

test('a contract returning nothing is not a success', () => {
  const estimate = interpretEstimate({ result: { result: true }, constant_result: [] });
  assert.equal(estimate.willSucceed, false);
  assert.equal(estimate.message, 'contract returned nothing');
});

test('an rpc-level failure is not a success', () => {
  const estimate = interpretEstimate({ result: { result: false }, constant_result: ['0'.repeat(63) + '1'] });
  assert.equal(estimate.willSucceed, false);
});

test('an empty reply is not a success', () => {
  const estimate = interpretEstimate({});
  assert.equal(estimate.willSucceed, false);
  assert.equal(estimate.energyUsed, 0n);
});

test('node messages are decoded from hex', () => {
  assert.equal(decodeHexMessage('524556455254206f70636f6465206578656375746564'), 'REVERT opcode executed');
  // Plain text passes through untouched.
  assert.equal(decodeHexMessage('already readable'), 'already readable');
  assert.equal(decodeHexMessage(''), '');
});
