import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hashPassword, verifyPassword, decoyHash, generatePassword, MIN_PASSWORD_LENGTH } from './password.ts';
import { seal, open, newSecretboxKey, parseSecretboxKey, SecretboxError } from './secretbox.ts';
import { newSessionToken, hashSessionToken } from './session.ts';

const D = String.fromCharCode(36); // the dollar sign, spelled so no string replacement can reinterpret it
const stored = (...parts: string[]) => parts.join(D);

test('a password verifies against its own hash and nothing else', async () => {
  const hash = await hashPassword('correct horse battery staple');
  assert.equal(await verifyPassword('correct horse battery staple', hash), true);
  assert.equal(await verifyPassword('correct horse battery stapl', hash), false);
  assert.equal(await verifyPassword('', hash), false);
});

test('the stored hash carries its own parameters and never the password', async () => {
  const hash = await hashPassword('another long passphrase');
  const parts = hash.split(D);
  assert.deepEqual(parts.slice(0, 4), ['scrypt', '15', '8', '1']);
  assert.equal(parts.length, 6);
  assert.equal(hash.includes('another'), false);
});

test('the same password hashes differently each time', async () => {
  // A per-hash salt: two operators with one password do not share a hash, and
  // a precomputed table is useless.
  const a = await hashPassword('shared by two people');
  const b = await hashPassword('shared by two people');
  assert.notEqual(a, b);
  assert.equal(await verifyPassword('shared by two people', b), true);
});

test('equivalent Unicode spellings of a password are the same password', async () => {
  // An accented letter typed as one code point on one keyboard and as a letter
  // plus a combining accent on another must not lock someone out.
  const hash = await hashPassword('caf' + String.fromCharCode(0xe9) + ' au lait, please');
  assert.equal(await verifyPassword('cafe' + String.fromCharCode(0x301) + ' au lait, please', hash), true);
});

test('short passwords are refused', async () => {
  await assert.rejects(hashPassword('x'.repeat(MIN_PASSWORD_LENGTH - 1)));
});

test('a malformed or hostile stored hash fails closed, never throws', async () => {
  // A cost of 2^30 would try to allocate gigabytes on a single login.
  const bomb = stored('scrypt', '30', '8', '1', Buffer.alloc(16).toString('base64url'), Buffer.alloc(64).toString('base64url'));
  const cases = ['', 'plain', stored('scrypt', '15', '8', '1', 'abc'), stored('bcrypt', '10', 'x', 'y', 'z', 'w'),
    stored('scrypt', 'NaN', '8', '1', 'aa', 'bb'), bomb];
  for (const value of cases) {
    assert.equal(await verifyPassword('anything at all', value), false, value);
  }
});

test('the decoy hash is real work and matches no guess', async () => {
  // Used for unknown accounts, so a login for a nonexistent address takes as
  // long as one for a real address with a wrong password.
  const decoy = await decoyHash();
  assert.equal(decoy.split(D)[0], 'scrypt');
  assert.equal(await verifyPassword('password123456', decoy), false);
});

test('generated passwords are long and unique', () => {
  const a = generatePassword();
  assert.ok(a.length >= 24);
  assert.notEqual(a, generatePassword());
});

test('a sealed secret opens with its key and not with another', () => {
  const key = parseSecretboxKey(newSecretboxKey());
  const sealed = seal('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', key);

  assert.equal(open(sealed, key), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.equal(sealed.includes('GEZDGNBV'), false);
  assert.throws(() => open(sealed, parseSecretboxKey(newSecretboxKey())), SecretboxError);
});

test('a sealed value altered in the database fails to open instead of changing', () => {
  const key = parseSecretboxKey(newSecretboxKey());
  const parts = seal('the secret', key).split('.');
  const body = Buffer.from(parts[3]!, 'base64url');
  body[0] = body[0]! ^ 1;
  parts[3] = body.toString('base64url');
  assert.throws(() => open(parts.join('.'), key), SecretboxError);
});

test('sealing twice gives different ciphertexts', () => {
  const key = parseSecretboxKey(newSecretboxKey());
  assert.notEqual(seal('same', key), seal('same', key));
});

test('a missing or wrong-sized key is refused at startup', () => {
  assert.throws(() => parseSecretboxKey(undefined), /not set/);
  assert.throws(() => parseSecretboxKey(Buffer.alloc(16).toString('base64')), /32 bytes/);
});

test('session tokens are random and stored only as a hash', () => {
  const token = newSessionToken();
  assert.equal(Buffer.from(token, 'base64url').length, 32);
  assert.notEqual(token, newSessionToken());
  assert.match(hashSessionToken(token), /^[0-9a-f]{64}$/);
  assert.equal(hashSessionToken(token), hashSessionToken(token));
});
