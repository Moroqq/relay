import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { DepositWallet, deriveHotWallet, sealMnemonic } from '@relay/wallet';

import type { KeySource } from './config.ts';
import { startControlServer } from './control.ts';
import { checkKeys, KeyHolder } from './keys.ts';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const OTHER = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const PASSPHRASE = 'a passphrase long enough to pass';

const settingsFor = (mnemonic: string) => ({
  hotWalletAddress: deriveHotWallet(mnemonic).address,
  depositXpub: DepositWallet.fromMnemonic(mnemonic).accountXpub(),
});
const SETTINGS = settingsFor(MNEMONIC);

async function keystoreSource(): Promise<KeySource> {
  const keystore = await sealMnemonic(MNEMONIC, PASSPHRASE, { cost: 2 ** 15 });
  return { kind: 'keystore', path: 'unused', keystore, controlSocket: 'unused' };
}

test('keys that do not match the configured hot wallet or deposit key are refused', () => {
  assert.throws(() => checkKeys(OTHER, SETTINGS), /hot wallet/);
  assert.throws(() => checkKeys(MNEMONIC, { ...SETTINGS, depositXpub: settingsFor(OTHER).depositXpub }), /deposit addresses/);
  assert.equal(checkKeys(MNEMONIC, SETTINGS).hotWallet.address, SETTINGS.hotWalletAddress);
});

test('with a keystore the sweeper starts locked, and only the right passphrase opens it', async () => {
  const holder = new KeyHolder(SETTINGS, await keystoreSource());
  assert.equal(holder.state, 'locked');
  assert.equal(holder.keys, null);

  assert.equal((await holder.unlock('not the passphrase at all')).ok, false);
  assert.equal(holder.state, 'locked');

  assert.deepEqual(await holder.unlock(PASSPHRASE), { ok: true });
  assert.equal(holder.keys?.hotWallet.address, SETTINGS.hotWalletAddress);
});

test('a keystore for another deployment\'s wallets does not unlock', async () => {
  const holder = new KeyHolder(settingsFor(OTHER), await keystoreSource());
  const result = await holder.unlock(PASSPHRASE);
  assert.equal(result.ok, false);
  assert.equal(holder.state, 'locked');
});

test('locking wipes the keys, not just the reference to them', async () => {
  const holder = new KeyHolder(SETTINGS, await keystoreSource());
  await holder.unlock(PASSPHRASE);
  const keys = holder.keys!;
  holder.lock();
  assert.equal(holder.keys, null);
  assert.ok(keys.hotWallet.privateKey.every((b) => b === 0));
  assert.throws(() => keys.wallet.derivePrivateKey(0));
});

test('development keys from the environment are unlocked from the start', () => {
  const holder = new KeyHolder(SETTINGS, { kind: 'environment', mnemonic: MNEMONIC });
  assert.equal(holder.state, 'unlocked');
});

function ask(socketPath: string, request: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'));
    socket.on('data', (chunk: string) => { buffer += chunk; });
    socket.on('end', () => resolve(JSON.parse(buffer) as Record<string, unknown>));
    socket.on('error', reject);
  });
}

test('the control socket unlocks, reports and locks', async () => {
  const name = 'relay-test-' + randomBytes(6).toString('hex');
  const socketPath = process.platform === 'win32' ? '\\\\.\\pipe\\' + name : path.join(os.tmpdir(), name + '.sock');
  const holder = new KeyHolder(SETTINGS, await keystoreSource());
  const changes: string[] = [];
  const server = await startControlServer(socketPath, holder, { log: () => {}, onChange: (state) => changes.push(state) });
  try {
    assert.deepEqual(await ask(socketPath, { cmd: 'status' }), { ok: true, state: 'locked' });
    const wrong = await ask(socketPath, { cmd: 'unlock', passphrase: 'wrong wrong wrong wrong' });
    assert.equal(wrong['ok'], false);
    const right = await ask(socketPath, { cmd: 'unlock', passphrase: PASSPHRASE });
    assert.deepEqual(right, { ok: true, state: 'unlocked', hot_wallet: SETTINGS.hotWalletAddress });
    assert.deepEqual(await ask(socketPath, { cmd: 'lock' }), { ok: true, state: 'locked' });
    assert.deepEqual(await ask(socketPath, { cmd: 'nonsense' }), { ok: false, error: 'Unknown command' });
    assert.deepEqual(changes, ['unlocked', 'locked']);
    assert.equal(holder.state, 'locked');
  } finally {
    server.close();
  }
});
