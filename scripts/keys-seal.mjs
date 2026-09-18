/**
 * Encrypt the master mnemonic into a keystore file for the server.
 *
 *   npm run keys:seal -- --out relay.keystore.json          seal WALLET_MNEMONIC (or type it in)
 *   npm run keys:seal -- --out relay.keystore.json --new    make a fresh mnemonic first
 *
 * Run it on your own computer, not on the server: the mnemonic in the clear
 * should never touch the server's disk. Copy only the keystore file there.
 *
 * Prints a generated passphrase once. The sweeper asks for it after every
 * start; keep it in a password manager, apart from the mnemonic backup.
 */
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { assertValidMnemonic, newMnemonic, openKeystore, sealMnemonic, serializeKeystore } from '@relay/wallet';

import { ask, askHidden } from './lib/prompt.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(root, '.env')); } catch {}

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const out = outIndex === -1 ? undefined : args[outIndex + 1];
const fresh = args.includes('--new');

if (!out) {
  console.error('Usage: npm run keys:seal -- --out relay.keystore.json [--new]');
  process.exit(1);
}
if (existsSync(out)) {
  console.error(`${out} already exists. Choose another name; an existing keystore is never overwritten.`);
  process.exit(1);
}

/** 30 characters from an alphabet without look-alikes: 150 bits, grouped for typing. */
function newPassphrase() {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const chars = [...randomBytes(30)].map((b) => alphabet[b & 31]).join('');
  return chars.match(/.{5}/g).join('-');
}

let mnemonic;
if (fresh) {
  mnemonic = newMnemonic();
  const words = mnemonic.split(' ');
  console.log('\n  A new master mnemonic. Write these 24 words on paper, in order, now.');
  console.log('  They are the only way to recover every deposit address and the hot wallet.\n');
  for (let i = 0; i < words.length; i += 6) {
    console.log('  ' + words.slice(i, i + 6).map((w, j) => String(i + j + 1).padStart(2) + '. ' + w.padEnd(10)).join(''));
  }
  const check = 3 + Math.floor(Math.random() * 20);
  const answer = (await ask(`\n  To confirm the backup, type word number ${check}: `)).trim().toLowerCase();
  if (answer !== words[check - 1]) {
    console.error('  That is not word ' + check + '. Nothing was written; run it again.');
    process.exit(1);
  }
  console.clear();
} else {
  mnemonic = process.env.WALLET_MNEMONIC?.trim() || (await askHidden('Mnemonic (hidden): ')).trim();
}
assertValidMnemonic(mnemonic);

const passphrase = newPassphrase();
const keystore = await sealMnemonic(mnemonic, passphrase);
// Prove the file opens before anyone relies on it.
if ((await openKeystore(keystore, passphrase)) !== mnemonic) throw new Error('Keystore did not round-trip');
writeFileSync(out, serializeKeystore(keystore), { mode: 0o600, flag: 'wx' });

console.log(`
  Keystore written to ${out}

  Passphrase — shown once. Put it in a password manager now:

    ${passphrase}

  For the server's environment:

    KEYSTORE_PATH=/path/on/the/server/${path.basename(out)}
    DEPOSIT_XPUB=${keystore.depositXpub}
    HOT_WALLET_ADDRESS=${keystore.hotWallet}

  Then remove WALLET_MNEMONIC from the server. After each start of the
  sweeper, unlock it with: npm run keys:unlock
`);
