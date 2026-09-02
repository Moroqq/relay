import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  signPayload,
  verifySignature,
  retryDelayMs,
  shouldRetry,
  isRetriableStatus,
  MAX_WEBHOOK_ATTEMPTS,
} from './webhooks.ts';

const SECRET = 'whsec_test_9f2a1c';
const BODY = JSON.stringify({ event: 'payment.completed', id: 'PAY_9C4D18' });
const NOW = 1_800_000_000;

test('a signature we produce is one we accept', () => {
  const header = signPayload(BODY, SECRET, NOW);
  assert.ok(verifySignature(BODY, SECRET, header, { nowSeconds: NOW }));
});

test('a tampered body fails verification', () => {
  const header = signPayload(BODY, SECRET, NOW);
  const tampered = JSON.stringify({ event: 'payment.completed', id: 'PAY_ATTACKER' });
  assert.equal(verifySignature(tampered, SECRET, header, { nowSeconds: NOW }), false);
});

test('the wrong secret fails verification', () => {
  const header = signPayload(BODY, SECRET, NOW);
  assert.equal(verifySignature(BODY, 'whsec_wrong', header, { nowSeconds: NOW }), false);
});

test('an old callback cannot be replayed', () => {
  const header = signPayload(BODY, SECRET, NOW);
  // Ten minutes later, past the five-minute tolerance.
  assert.equal(verifySignature(BODY, SECRET, header, { nowSeconds: NOW + 600 }), false);
  // Still fine a minute later.
  assert.ok(verifySignature(BODY, SECRET, header, { nowSeconds: NOW + 60 }));
});

test('re-dating a captured signature does not help an attacker', () => {
  // The timestamp is signed, not merely attached, so swapping it breaks the mac.
  const header = signPayload(BODY, SECRET, NOW);
  const forged = header.replace(`t=${NOW}`, `t=${NOW + 600}`);
  assert.equal(verifySignature(BODY, SECRET, forged, { nowSeconds: NOW + 600 }), false);
});

test('malformed signature headers are rejected, not crashed on', () => {
  for (const bad of ['', 'garbage', 't=abc,v1=def', 't=1800000000', 'v1=deadbeef', 't=1800000000,v1=zz']) {
    assert.equal(
      verifySignature(BODY, SECRET, bad, { nowSeconds: NOW }),
      false,
      `should reject ${JSON.stringify(bad)}`,
    );
  }
});

test('a truncated signature is rejected rather than throwing', () => {
  const header = signPayload(BODY, SECRET, NOW);
  const truncated = header.slice(0, header.length - 10);
  assert.equal(verifySignature(BODY, SECRET, truncated, { nowSeconds: NOW }), false);
});

test('retries spread out instead of hammering a struggling endpoint', () => {
  assert.equal(retryDelayMs(1), 0);
  assert.equal(retryDelayMs(2), 30_000);
  assert.equal(retryDelayMs(5), 3_600_000);
  // Total window is over an hour, enough for a human to notice and fix.
  const total = [1, 2, 3, 4, 5].reduce((sum, n) => sum + retryDelayMs(n), 0);
  assert.ok(total > 60 * 60 * 1000);
});

test('server errors are retried, client rejections are not', () => {
  assert.ok(isRetriableStatus(500));
  assert.ok(isRetriableStatus(502)); // the PAY_9C4D18 scenario
  assert.ok(isRetriableStatus(503));
  assert.ok(isRetriableStatus(429)); // rate limited: back off and try again
  assert.ok(isRetriableStatus(408));

  // A merchant rejecting the payload will reject it identically next time.
  assert.equal(isRetriableStatus(400), false);
  assert.equal(isRetriableStatus(401), false);
  assert.equal(isRetriableStatus(404), false);
  assert.equal(isRetriableStatus(422), false);
  assert.equal(isRetriableStatus(200), false);
});

test('a dead connection is always worth one more attempt', () => {
  assert.ok(shouldRetry(1, null));
  assert.ok(shouldRetry(4, null));
});

test('retries stop at the cap even for a retriable error', () => {
  assert.ok(shouldRetry(MAX_WEBHOOK_ATTEMPTS - 1, 502));
  assert.equal(shouldRetry(MAX_WEBHOOK_ATTEMPTS, 502), false);
});

test('an invalid attempt number is a bug, not a default', () => {
  for (const bad of [0, -1, 1.5]) {
    assert.throws(() => retryDelayMs(bad), RangeError);
  }
});
