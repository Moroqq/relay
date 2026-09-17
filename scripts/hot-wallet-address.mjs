/**
 * Print the hot wallet address this mnemonic derives, to put in
 * HOT_WALLET_ADDRESS. Prints the address only — never the key.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveHotWallet } from '@relay/wallet';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(root, '.env')); } catch {}

const mnemonic = process.env.WALLET_MNEMONIC;
if (!mnemonic) {
  console.error('WALLET_MNEMONIC is not set.');
  process.exit(1);
}

const hot = deriveHotWallet(mnemonic);
console.log(`\n  HOT_WALLET_ADDRESS=${hot.address}\n  derived at ${hot.path}\n`);
console.log('  Fund it with TRX for fees and a USDT float, sent from the treasury');
console.log('  so the refill is booked. Keep the float small: this key lives on the server.\n');
