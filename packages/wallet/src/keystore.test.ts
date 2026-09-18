import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DepositAddresses, DepositWallet } from './address.ts';
import { deriveHotWallet } from './operational.ts';
import { openKeystore, parseKeystore, sealMnemonic, serializeKeystore, KeystoreError } from './keystore.ts';

const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PASSPHRASE = 'correct horse battery staple, twice';
// The cheapest cost the parser accepts, so the suite stays fast.
const CHEAP = { cost: 2 ** 15 };

test('a sealed mnemonic opens with its passphrase and survives a round trip through the file', async () => {
  const ks = parseKeystore(serializeKeystore(await sealMnemonic(TEST_MNEMONIC, PASSPHRASE, CHEAP)));
  assert.equal(await openKeystore(ks, PASSPHRASE), TEST_MNEMONIC);
  assert.equal(ks.hotWallet, deriveHotWallet(TEST_MNEMONIC).address);
  assert.equal(ks.depositXpub, DepositWallet.fromMnemonic(TEST_MNEMONIC).accountXpub());
});

test('the file holds no trace of the mnemonic in the clear', async () => {
  const text = serializeKeystore(await sealMnemonic(TEST_MNEMONIC, PASSPHRASE, CHEAP));
  assert.doesNotMatch(text, /abandon/);
});

test('a wrong passphrase is refused', async () => {
  const ks = await sealMnemonic(TEST_MNEMONIC, PASSPHRASE, CHEAP);
  await assert.rejects(openKeystore(ks, PASSPHRASE + '!'), KeystoreError);
});

test('swapping in another keystore\'s public keys makes the file fail to open', async () => {
  const ks = await sealMnemonic(TEST_MNEMONIC, PASSPHRASE, CHEAP);
  // An attacker who can edit the file but not decrypt it points the hot wallet
  // at their own address, hoping the server trusts the label.
  const forged = { ...ks, hotWallet: 'TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7' };
  await assert.rejects(openKeystore(forged, PASSPHRASE), /Wrong passphrase, or the keystore file was altered/);
});

test('a tampered ciphertext is refused', async () => {
  const ks = await sealMnemonic(TEST_MNEMONIC, PASSPHRASE, CHEAP);
  const bytes = Buffer.from(ks.ciphertext, 'base64');
  bytes[0] = bytes[0]! ^ 1;
  await assert.rejects(openKeystore({ ...ks, ciphertext: bytes.toString('base64') }, PASSPHRASE), KeystoreError);
});

test('derivation settings outside sane bounds are refused before any work is done', async () => {
  const good = JSON.parse(serializeKeystore(await sealMnemonic(TEST_MNEMONIC, PASSPHRASE, CHEAP)));
  const withCost = (n: number) => JSON.stringify({ ...good, kdf: { ...good.kdf, n } });
  assert.throws(() => parseKeystore(withCost(2 ** 10)), /out of bounds/); // too cheap to guess against
  assert.throws(() => parseKeystore(withCost(2 ** 24)), /out of bounds/); // built to exhaust memory
  assert.throws(() => parseKeystore(withCost(100_000)), /out of bounds/); // not a power of two
  assert.throws(() => parseKeystore('not json'), KeystoreError);
  assert.throws(() => parseKeystore(JSON.stringify({ ...good, version: 2 })), /version/);
});

test('a short passphrase or an invalid mnemonic is refused at sealing', async () => {
  await assert.rejects(sealMnemonic(TEST_MNEMONIC, 'short', CHEAP), /at least 16/);
  await assert.rejects(sealMnemonic('abandon abandon abandon', PASSPHRASE, CHEAP), /Invalid BIP39/);
});

test('the stored public key yields exactly the addresses the mnemonic does', async () => {
  const ks = await sealMnemonic(TEST_MNEMONIC, PASSPHRASE, CHEAP);
  const wallet = DepositWallet.fromMnemonic(TEST_MNEMONIC);
  const addresses = DepositAddresses.fromXpub(ks.depositXpub);
  for (const index of [0, 1, 7, 1000]) {
    assert.deepEqual(addresses.deriveAddress(index), wallet.deriveAddress(index));
  }
});
