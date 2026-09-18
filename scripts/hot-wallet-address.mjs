/**
 * Print the public keys this mnemonic yields, for the services that must not
 * hold the mnemonic itself: HOT_WALLET_ADDRESS and DEPOSIT_XPUB. Prints no
 * private key.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DepositWallet, deriveHotWallet } from '@relay/wallet';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(root, '.env')); } catch {}

const mnemonic = process.env.WALLET_MNEMONIC;
if (!mnemonic) {
  console.error('WALLET_MNEMONIC is not set.');
  process.exit(1);
}

const hot = deriveHotWallet(mnemonic);
const wallet = DepositWallet.fromMnemonic(mnemonic);
console.log(`\n  HOT_WALLET_ADDRESS=${hot.address}\n  DEPOSIT_XPUB=${wallet.accountXpub()}\n`);
console.log('  The hot wallet (derived at ' + hot.path + ') needs TRX for fees and a USDT float,');
console.log('  sent from the treasury so the refill is booked. Keep the float small.');
console.log('  DEPOSIT_XPUB lets the API hand out deposit addresses without the mnemonic.\n');
hot.privateKey.fill(0);
wallet.wipe();
