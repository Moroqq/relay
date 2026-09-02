import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Asset } from '@relay/core';
import {
  TRANSFER_TOPIC,
  decodeTransferLog,
  decodeNativeTransfer,
  extractTrc20Transfers,
  extractNativeTransfers,
  topicToAddress,
  dataToAmount,
  logAddressToBase58,
  chainAddressToBase58,
  isSuccessful,
} from './decode.ts';

/** USDT on the Nile testnet. */
const USDT_NILE = 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf';
const CONTRACTS = new Map<string, Asset>([[USDT_NILE, 'USDT']]);

/**
 * Captured from Nile block 70,613,514 — a genuine USDT transfer of
 * 96.403918 USDT. Kept verbatim so the decoder is tested against what the
 * chain actually emits rather than against what we assume it emits.
 */
const REAL_LOG = {
  address: 'eca9bc828a3005b9a3b909f2cc5c2a54794de05f',
  topics: [
    TRANSFER_TOPIC,
    '0000000000000000000000006d8dc0b4ad21672f7708c9ab102d769a4a230c69',
    '000000000000000000000000930f6c1442cedf6a24e251c2bc1af7157ca5856f',
  ],
  data: '0000000000000000000000000000000000000000000000000000000005bf01ce',
};

/** Captured from Nile block 70,613,539 — 0.313 TRX. */
const REAL_NATIVE = {
  txID: '7791f4e8cc938dcd8edd21ae7eac1a5273f5fff0b57fb7e607fc7002248dd7cf',
  ret: [{ contractRet: 'SUCCESS' }],
  raw_data: {
    contract: [
      {
        type: 'TransferContract',
        parameter: {
          value: {
            owner_address: '41f7c3feccb6461aab0fd25f61d9560645b08228cb',
            to_address: '41b06b4139895c9f51c967c9f3d9089ca721e8e34c',
            amount: 313000,
          },
        },
      },
    ],
  },
};

test('a real USDT transfer decodes to the right parties and amount', () => {
  const decoded = decodeTransferLog(REAL_LOG, CONTRACTS);
  assert.deepEqual(decoded, {
    asset: 'USDT',
    from: 'TKxUU8588Zdt44Ues3p62gULLXtgTJ2CGb',
    to: 'TPNnoowojVHucZZrKii9fox3Zq2MGLdXkp',
    amountUnits: 96_403918n,
  });
});

test('log addresses carry no 0x41 prefix, chain addresses do', () => {
  // The single most expensive confusion in TRON integration work: the same
  // account is 20 bytes in a log and 21 bytes in a transaction body.
  assert.equal(logAddressToBase58('eca9bc828a3005b9a3b909f2cc5c2a54794de05f'), USDT_NILE);
  assert.equal(chainAddressToBase58('41eca9bc828a3005b9a3b909f2cc5c2a54794de05f'), USDT_NILE);

  // Each rejects the other's format rather than producing a plausible wrong answer.
  assert.equal(logAddressToBase58('41eca9bc828a3005b9a3b909f2cc5c2a54794de05f'), null);
  assert.equal(chainAddressToBase58('eca9bc828a3005b9a3b909f2cc5c2a54794de05f'), null);
});

test('a transfer from an untracked contract is ignored', () => {
  // Most Transfer events on a live network belong to tokens that are not ours.
  // Crediting one as USDT would be free money for whoever deployed it.
  assert.equal(decodeTransferLog(REAL_LOG, new Map()), null);
});

test('a topic that is not an address is refused, not truncated', () => {
  // Non-zero bytes in the padding mean this slot holds something other than an
  // address. Taking the last 20 bytes anyway would invent an account.
  assert.equal(topicToAddress('00000000000000000000dead6d8dc0b4ad21672f7708c9ab102d769a4a230c69'), null);
  assert.equal(topicToAddress('0000000000000000000000006d8dc0b4ad21672f7708c9ab102d769a4a230c69'), 'TKxUU8588Zdt44Ues3p62gULLXtgTJ2CGb');
  assert.equal(topicToAddress('abc'), null);
  assert.equal(topicToAddress(''), null);
});

test('a zero-value transfer moves no money and opens no payment', () => {
  const probe = { ...REAL_LOG, data: '0'.repeat(64) };
  assert.equal(decodeTransferLog(probe, CONTRACTS), null);
});

test('malformed logs are skipped rather than thrown on', () => {
  const bad = [
    {},
    { ...REAL_LOG, topics: [TRANSFER_TOPIC] },
    { ...REAL_LOG, topics: [...REAL_LOG.topics, REAL_LOG.topics[1]!] },
    { ...REAL_LOG, topics: ['00'.repeat(32), REAL_LOG.topics[1]!, REAL_LOG.topics[2]!] },
    { ...REAL_LOG, data: 'nothex' },
    { ...REAL_LOG, address: 'zz' },
  ];
  for (const log of bad) {
    assert.doesNotThrow(() => decodeTransferLog(log, CONTRACTS));
    assert.equal(decodeTransferLog(log, CONTRACTS), null);
  }
});

test('amounts read as unsigned 256-bit integers', () => {
  assert.equal(dataToAmount('0'.repeat(56) + '05bf01ce'), 96_403918n);
  assert.equal(dataToAmount('f'.repeat(64)), 2n ** 256n - 1n);
  assert.equal(dataToAmount(''), null);
  assert.equal(dataToAmount('f'.repeat(66)), null);
});

test('a real TRX transfer decodes', () => {
  assert.deepEqual(decodeNativeTransfer(REAL_NATIVE), {
    asset: 'TRX',
    from: 'TYZGhS8UG5okCZneaJoYZJJhsqeD6ZZZZZ',
    to: 'TS42R1n377ZvjCERGYDMjk3sgtCNpPPPPP',
    amountUnits: 313_000n,
  });
});

test('a failed transaction is not a payment', () => {
  // Failed transactions still appear in blocks. Reading one as received money
  // would credit a merchant for funds that never moved.
  const failed = { ...REAL_NATIVE, ret: [{ contractRet: 'OUT_OF_ENERGY' }] };
  assert.equal(isSuccessful(failed), false);
  assert.equal(decodeNativeTransfer(failed), null);

  // An unrecognised shape defaults to "did not succeed".
  assert.equal(isSuccessful({}), false);
  assert.equal(isSuccessful({ ret: [] }), false);
});

test('non-transfer contracts are ignored', () => {
  const freeze = {
    ...REAL_NATIVE,
    raw_data: { contract: [{ type: 'FreezeBalanceV2Contract', parameter: { value: {} } }] },
  };
  assert.equal(decodeNativeTransfer(freeze), null);
});

test('several transfers in one transaction each keep their position', () => {
  // A batch payout is one transaction with many logs. Keying by hash alone
  // would collapse them into one and lose every payment but the first.
  const infos = [{ id: 'aa'.repeat(32), receipt: { result: 'SUCCESS' }, log: [REAL_LOG, REAL_LOG, REAL_LOG] }];
  const found = extractTrc20Transfers(infos, CONTRACTS);
  assert.equal(found.length, 3);
  assert.deepEqual(found.map((t) => t.logIndex), [0, 1, 2]);
  assert.equal(new Set(found.map((t) => `${t.txHash}:${t.logIndex}`)).size, 3);
});

test('a reverted contract call emits nothing we act on', () => {
  const infos = [{ id: 'bb'.repeat(32), receipt: { result: 'REVERT' }, log: [REAL_LOG] }];
  assert.deepEqual(extractTrc20Transfers(infos, CONTRACTS), []);
});

test('log positions survive untracked contracts in between', () => {
  const other = { ...REAL_LOG, address: '11'.repeat(20) };
  const infos = [{ id: 'cc'.repeat(32), receipt: { result: 'SUCCESS' }, log: [other, REAL_LOG] }];
  const found = extractTrc20Transfers(infos, CONTRACTS);
  assert.equal(found.length, 1);
  // Position 1, not 0: indices count every log so they stay stable if the
  // set of tracked contracts changes later.
  assert.equal(found[0]!.logIndex, 1);
});

test('native transfers get a log index that cannot collide with a TRC20 one', () => {
  const found = extractNativeTransfers([REAL_NATIVE]);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.logIndex, -1);
});

test('an empty block yields nothing', () => {
  assert.deepEqual(extractTrc20Transfers([], CONTRACTS), []);
  assert.deepEqual(extractNativeTransfers([]), []);
});
