import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hotp, totp, verifyTotp, newTotpSecret, decodeTotpSecret, otpauthUri, totpCounter } from './totp.ts';

/** RFC 6238 Appendix B and RFC 4226 Appendix D use this ASCII secret. */
const RFC_KEY = new TextEncoder().encode('12345678901234567890');

test('matches the SHA-1 test vectors printed in RFC 6238', () => {
  const vectors: [number, string][] = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];
  for (const [time, code] of vectors) assert.equal(totp(RFC_KEY, time, 8), code, 'T=' + time);
});

test('matches the HOTP test vectors printed in RFC 4226', () => {
  const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
  expected.forEach((code, counter) => assert.equal(hotp(RFC_KEY, BigInt(counter)), code, 'count ' + counter));
});

test('the RFC secret round-trips through base32 as authenticator apps show it', () => {
  assert.deepEqual(decodeTotpSecret('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'), RFC_KEY);
  // Apps display secrets in groups and sometimes lower case; both must work.
  assert.deepEqual(decodeTotpSecret('gezd gnbv gy3t qojq gezd gnbv gy3t qojq'), RFC_KEY);
});

test('a current code is accepted and a wrong one is not', () => {
  const now = 1_800_000_000;
  const code = totp(RFC_KEY, now);
  assert.equal(verifyTotp(RFC_KEY, code, now, null).ok, true);
  assert.equal(verifyTotp(RFC_KEY, code === '000000' ? '111111' : '000000', now, null).ok, false);
});

test('a code from one step either side is accepted, three steps is not', () => {
  const now = 1_800_000_000;
  assert.equal(verifyTotp(RFC_KEY, totp(RFC_KEY, now - 30), now, null).ok, true);
  assert.equal(verifyTotp(RFC_KEY, totp(RFC_KEY, now + 30), now, null).ok, true);
  assert.equal(verifyTotp(RFC_KEY, totp(RFC_KEY, now - 90), now, null).ok, false);
});

test('a code cannot be used twice', () => {
  // Otherwise a code seen over a shoulder stays usable for its whole window.
  const now = 1_800_000_000;
  const code = totp(RFC_KEY, now);
  const first = verifyTotp(RFC_KEY, code, now, null);
  assert.equal(first.ok, true);
  assert.equal(first.counter, totpCounter(now));

  assert.equal(verifyTotp(RFC_KEY, code, now + 5, first.counter).ok, false);
  // An older code is refused too, though it would otherwise be in window.
  assert.equal(verifyTotp(RFC_KEY, totp(RFC_KEY, now - 30), now, first.counter).ok, false);
  // The next one is fine.
  assert.equal(verifyTotp(RFC_KEY, totp(RFC_KEY, now + 30), now + 30, first.counter).ok, true);
});

test('malformed codes are refused', () => {
  for (const bad of ['', '12345', '1234567', 'abcdef', '12x456']) {
    assert.equal(verifyTotp(RFC_KEY, bad, 1_800_000_000, null).ok, false, JSON.stringify(bad));
  }
});

test('new secrets are 20 random bytes and all different', () => {
  const a = newTotpSecret();
  assert.equal(decodeTotpSecret(a).length, 20);
  assert.notEqual(a, newTotpSecret());
});

test('the otpauth link carries what an authenticator app needs', () => {
  const uri = otpauthUri('GEZDGNBVGY3TQOJQ', 'owner@relay');
  assert.ok(uri.startsWith('otpauth://totp/Relay%20Console%3Aowner%40relay?'));
  assert.ok(uri.includes('secret=GEZDGNBVGY3TQOJQ'));
  assert.ok(uri.includes('period=30') && uri.includes('digits=6'));
});
