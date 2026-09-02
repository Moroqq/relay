import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import tronwebPkg from 'tronweb';

import {
  DepositWallet,
  addressFromPrivateKey,
  decodeAddress,
  isValidAddress,
  newMnemonic,
  WalletError,
} from './address.ts';

const TronWeb = (tronwebPkg as any).TronWeb ?? (tronwebPkg as any).default;

/** The standard BIP39 test mnemonic. Public, worthless, in every test suite. */
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

test('the keccak pipeline matches a public Ethereum vector', () => {
  // TRON and Ethereum derive the account hash identically; only the prefix and
  // the text encoding differ. So the widely published Ethereum address for
  // this mnemonic at m/44'/60'/0'/0/0 proves the seed -> key -> keccak -> last
  // 20 bytes half of our derivation, independently of anything TRON-specific.
  const seed = mnemonicToSeedSync(TEST_MNEMONIC, '');
  const node = HDKey.fromMasterSeed(seed).derive("m/44'/60'/0'/0/0");
  assert.ok(node.privateKey);

  const uncompressed = secp256k1.getPublicKey(node.privateKey, false);
  const ethAddress = '0x' + bytesToHex(keccak_256(uncompressed.subarray(1)).subarray(12));

  assert.equal(ethAddress, '0x9858effd232b4033e47d90003d41ec34ecaeda94');
});

test('derived addresses match TronWeb, an independent implementation', () => {
  // If our Base58Check, prefix or hashing were subtly wrong, this diverges.
  const wallet = DepositWallet.fromMnemonic(TEST_MNEMONIC);

  for (let index = 0; index < 25; index++) {
    const derived = wallet.deriveAddress(index);
    const privateKey = wallet.derivePrivateKey(index);
    const expected = TronWeb.address.fromPrivateKey(bytesToHex(privateKey));

    assert.equal(derived.address, expected, `index ${index} diverged`);
    assert.ok(TronWeb.isAddress(derived.address), `TronWeb rejected ${derived.address}`);
  }
});

test('derivation is deterministic — the same mnemonic always rebuilds the same addresses', () => {
  // This is what lets us recover every deposit address after losing the
  // database, and what makes the stored BIP44 path sufficient as a backup.
  const first = DepositWallet.fromMnemonic(TEST_MNEMONIC).deriveAddress(7);
  const second = DepositWallet.fromMnemonic(TEST_MNEMONIC).deriveAddress(7);

  assert.deepEqual(first, second);
  assert.equal(first.path, "m/44'/195'/0'/0/7");
});

test('every index yields a different address', () => {
  const wallet = DepositWallet.fromMnemonic(TEST_MNEMONIC);
  const seen = new Set<string>();
  for (let index = 0; index < 200; index++) seen.add(wallet.deriveAddress(index).address);
  assert.equal(seen.size, 200);
});

test('separate accounts are separate address spaces', () => {
  const a = DepositWallet.fromMnemonic(TEST_MNEMONIC, { account: 0 }).deriveAddress(0);
  const b = DepositWallet.fromMnemonic(TEST_MNEMONIC, { account: 1 }).deriveAddress(0);
  assert.notEqual(a.address, b.address);
});

test('a passphrase produces an entirely different wallet', () => {
  const plain = DepositWallet.fromMnemonic(TEST_MNEMONIC).deriveAddress(0);
  const guarded = DepositWallet.fromMnemonic(TEST_MNEMONIC, { passphrase: 'hunter2' }).deriveAddress(0);
  assert.notEqual(plain.address, guarded.address);
});

test('addresses look like TRON addresses', () => {
  const wallet = DepositWallet.fromMnemonic(TEST_MNEMONIC);
  for (let index = 0; index < 10; index++) {
    const { address } = wallet.deriveAddress(index);
    assert.match(address, /^T[1-9A-HJ-NP-Za-km-z]{33}$/);
    assert.equal(address.length, 34);
  }
});

test('a mistyped address fails the checksum instead of eating the funds', () => {
  const good = DepositWallet.fromMnemonic(TEST_MNEMONIC).deriveAddress(0).address;
  assert.ok(isValidAddress(good));

  // Swap one character. Base58Check must catch it.
  const swap = good[10] === 'a' ? 'b' : 'a';
  const typo = good.slice(0, 10) + swap + good.slice(11);
  assert.equal(isValidAddress(typo), false);
  assert.throws(() => decodeAddress(typo), WalletError);
});

test('garbage input is rejected, not coerced', () => {
  for (const bad of ['', 'hello', '0x9858effd232b4033e47d90003d41ec34ecaeda94', 'T', 'TTTTT']) {
    assert.equal(isValidAddress(bad), false, `should reject ${JSON.stringify(bad)}`);
  }
});

test('a bad mnemonic is refused up front', () => {
  assert.throws(() => DepositWallet.fromMnemonic('not a real mnemonic at all'), WalletError);
  // Valid words, broken checksum — the subtle case that must not slip through.
  assert.throws(
    () => DepositWallet.fromMnemonic('abandon '.repeat(11) + 'abandon'),
    WalletError,
  );
});

test('generated mnemonics are usable and unique', () => {
  const a = newMnemonic();
  const b = newMnemonic();
  assert.equal(a.split(' ').length, 24);
  assert.notEqual(a, b);
  assert.doesNotThrow(() => DepositWallet.fromMnemonic(a));
});

test('an out-of-range index is a programming error, not a silent wrap', () => {
  const wallet = DepositWallet.fromMnemonic(TEST_MNEMONIC);
  for (const bad of [-1, 1.5, 2 ** 31, NaN]) {
    assert.throws(() => wallet.deriveAddress(bad), WalletError, `should reject ${bad}`);
  }
});

test('addressFromPrivateKey agrees with TronWeb on random keys', () => {
  for (let i = 0; i < 20; i++) {
    const key = secp256k1.utils.randomSecretKey();
    assert.equal(addressFromPrivateKey(key), TronWeb.address.fromPrivateKey(bytesToHex(key)));
  }
});
