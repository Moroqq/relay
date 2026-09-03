import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { bytesToHex } from '@noble/hashes/utils.js';
import { DepositWallet, decodeAddress } from '@relay/wallet';
import tronwebPkg from 'tronweb';

import { encodeTransfer, decodeTransfer, TRANSFER_SELECTOR, selectorOf, AbiError } from './abi.ts';
import { signTransaction, signTransactionHash, assertMatchesIntent, SigningError } from './sign.ts';

const TronWeb = (tronwebPkg as any).TronWeb ?? (tronwebPkg as any).default;

const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const wallet = DepositWallet.fromMnemonic(TEST_MNEMONIC);
const privateKey = wallet.derivePrivateKey(0);

const USDT_NILE = 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf';
const RECIPIENT = 'TPNnoowojVHucZZrKii9fox3Zq2MGLdXkp';

/**
 * A transfer transaction built by a real Nile node and captured verbatim.
 * Using a fixture keeps these tests offline while still exercising the exact
 * shape the network produces.
 */
const FIXTURE = JSON.parse(
  readFileSync(new URL('./fixture-transaction.json', import.meta.url), 'utf8'),
);

const INTENT = {
  ownerHex: bytesToHex(decodeAddress(wallet.deriveAddress(0).address)),
  contractHex: bytesToHex(decodeAddress(USDT_NILE)),
  dataHex: encodeTransfer(RECIPIENT, 480_000000n),
};

test('the transfer selector is the well-known ERC20 one', () => {
  assert.equal(TRANSFER_SELECTOR, 'a9059cbb');
  assert.equal(selectorOf('transfer(address,uint256)'), 'a9059cbb');
});

test('an encoded transfer round-trips', () => {
  const data = encodeTransfer(RECIPIENT, 480_000000n);
  const decoded = decodeTransfer(data);
  assert.equal(decoded.amountUnits, 480_000000n);
  assert.equal(decoded.toAccountHash, bytesToHex(decodeAddress(RECIPIENT).subarray(1)));
});

test('the recipient is encoded without TRON s 0x41 prefix', () => {
  // Inside the EVM an address is 20 bytes. Including the prefix would shift
  // every following byte and send the money to an address nobody controls.
  const data = encodeTransfer(RECIPIENT, 1n);
  assert.equal(data.slice(8, 8 + 24), '0'.repeat(24));
  assert.doesNotMatch(data.slice(8, 8 + 64), /^0{22}41/);
});

test('a mistyped payout address is refused before anything is signed', () => {
  const good = RECIPIENT;
  const typo = good.slice(0, 10) + (good[10] === 'a' ? 'b' : 'a') + good.slice(11);
  assert.throws(() => encodeTransfer(typo, 1n));
});

test('zero and absurd amounts are refused', () => {
  assert.throws(() => encodeTransfer(RECIPIENT, 0n), AbiError);
  assert.throws(() => encodeTransfer(RECIPIENT, -1n), AbiError);
  assert.throws(() => encodeTransfer(RECIPIENT, 2n ** 256n), AbiError);
});

test('decoding rejects data that is not a transfer', () => {
  assert.throws(() => decodeTransfer('deadbeef' + '0'.repeat(128)), AbiError);
  assert.throws(() => decodeTransfer(TRANSFER_SELECTOR + '00'), AbiError);
  // Non-zero padding in the recipient word means it is not an address.
  assert.throws(
    () => decodeTransfer(TRANSFER_SELECTOR + 'ff'.repeat(32) + '00'.repeat(32)),
    AbiError,
  );
});

test('our signature is byte-for-byte what TronWeb produces', async () => {
  // The reference implementation whose transactions the network has accepted
  // billions of times. If our signing diverges anywhere, this catches it.
  const mine = signTransaction(structuredClone(FIXTURE), INTENT, privateKey);
  const tronweb = new TronWeb({ fullHost: 'https://nile.trongrid.io' });
  const theirs = await tronweb.trx.sign(structuredClone(FIXTURE), bytesToHex(privateKey));

  assert.equal(mine.signature[0], theirs.signature[0].toLowerCase());
});

test('the signature header is the recovery id plus 27', () => {
  // TRON inherited Ethereum's offset. A bare recovery id of 0 or 1 is rejected
  // by the validator, and the failure message says only "signature validate
  // failed" — so this single byte is worth a test of its own.
  const signature = signTransactionHash(FIXTURE.txID, privateKey);
  assert.equal(signature.length, 130); // 65 bytes
  const header = Number.parseInt(signature.slice(-2), 16);
  assert.ok(header === 27 || header === 28, `header was ${header}`);
});

test('signing verifies the transaction id against its own bytes', () => {
  // A node claiming a txID that is not the hash of the raw_data it sent would
  // have us authorise something we never saw.
  const lying = { ...structuredClone(FIXTURE), txID: 'ab'.repeat(32) };
  assert.throws(() => assertMatchesIntent(lying, INTENT), /does not match its own bytes/);
});

test('signing refuses a transaction that is not what we asked for', () => {
  const swapped = structuredClone(FIXTURE);
  // Same shape, different recipient inside the call data.
  swapped.raw_data.contract[0].parameter.value.data = encodeTransfer(
    'TKxUU8588Zdt44Ues3p62gULLXtgTJ2CGb',
    480_000000n,
  );
  assert.throws(() => signTransaction(swapped, INTENT, privateKey), SigningError);
});

test('signing refuses a transaction against a different contract', () => {
  const swapped = structuredClone(FIXTURE);
  swapped.raw_data.contract[0].parameter.value.contract_address = '41' + 'ab'.repeat(20);
  assert.throws(() => signTransaction(swapped, INTENT, privateKey), /contract_address/);
});

test('signing refuses a transaction from a different owner', () => {
  const swapped = structuredClone(FIXTURE);
  swapped.raw_data.contract[0].parameter.value.owner_address = '41' + 'cd'.repeat(20);
  assert.throws(() => signTransaction(swapped, INTENT, privateKey), /owner_address/);
});

test('signing refuses anything that is not a contract call', () => {
  const swapped = structuredClone(FIXTURE);
  swapped.raw_data.contract[0].type = 'TransferContract';
  assert.throws(() => signTransaction(swapped, INTENT, privateKey), /Expected a TriggerSmartContract/);
});

test('the original transaction is not mutated by signing', () => {
  const original = structuredClone(FIXTURE);
  const signed = signTransaction(original, INTENT, privateKey);
  assert.equal('signature' in original, false);
  assert.equal(signed.txID, FIXTURE.txID);
});
