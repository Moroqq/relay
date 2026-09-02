import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newId, isId, shortenId, newApiKey, ID_PREFIXES } from './ids.ts';

test('ids carry a prefix that says what they are', () => {
  assert.match(newId('payment'), /^PAY_/);
  assert.match(newId('project'), /^PRJ_/);
  assert.match(newId('ledgerTransaction'), /^LTX_/);
});

test('ids avoid characters people misread', () => {
  // No I, L, O or U — the ones confused with 1, 0 and V when read aloud.
  for (let i = 0; i < 500; i++) {
    assert.doesNotMatch(newId('payment').slice(4), /[ILOU]/);
  }
});

test('ids do not collide', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 50_000; i++) seen.add(newId('payment'));
  assert.equal(seen.size, 50_000);
});

test('isId validates the kind, not just the shape', () => {
  const payment = newId('payment');
  assert.ok(isId(payment, 'payment'));
  assert.equal(isId(payment, 'project'), false);
  assert.equal(isId('PAY_short', 'payment'), false);
  assert.equal(isId('PAY_IIIIIIIIIIIIIIII', 'payment'), false); // excluded letters
  assert.equal(isId(null, 'payment'), false);
  assert.equal(isId(42, 'payment'), false);
});

test('every declared kind produces a valid id', () => {
  for (const kind of Object.keys(ID_PREFIXES) as (keyof typeof ID_PREFIXES)[]) {
    assert.ok(isId(newId(kind), kind), `${kind} failed`);
  }
});

test('shortening keeps the prefix so the kind stays readable', () => {
  const id = newId('payment');
  const short = shortenId(id);
  assert.match(short, /^PAY_[0-9A-Z]{6}$/);
  assert.ok(id.startsWith(short));
});

test('api keys announce their environment', () => {
  assert.match(newApiKey(true).secret, /^ak_live_/);
  assert.match(newApiKey(false).secret, /^ak_test_/);
});

test('an api key prefix is recognisable but not usable', () => {
  const key = newApiKey(true);
  assert.ok(key.secret.startsWith(key.prefix));
  // Four visible characters after the environment: enough to tell two keys
  // apart in a list, nowhere near enough to reconstruct one.
  assert.equal(key.prefix.length, 'ak_live_'.length + 4);
  assert.ok(key.secret.length > 40);
});

test('api keys do not repeat', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 5_000; i++) seen.add(newApiKey(true).secret);
  assert.equal(seen.size, 5_000);
});
