/**
 * Generate a fresh master mnemonic for a Relay deposit wallet.
 *
 * This phrase controls every deposit address the platform will ever issue.
 * Write it down offline. Do not paste it into chat, email, or a screenshot.
 * In production it belongs in a KMS or HSM, never in a file on a server.
 */
import { newMnemonic, DepositWallet } from '../packages/wallet/src/address.ts';

const mnemonic = newMnemonic();
const wallet = DepositWallet.fromMnemonic(mnemonic);

console.log('\n  MASTER MNEMONIC (24 words) — write this down offline\n');
console.log('  ' + mnemonic.split(' ').reduce((rows, word, i) => {
  const row = Math.floor(i / 6);
  rows[row] = (rows[row] ?? '') + `${String(i + 1).padStart(2)}. ${word.padEnd(10)}`;
  return rows;
}, []).join('\n  '));

console.log('\n  First deposit addresses derived from it:\n');
for (let i = 0; i < 3; i++) {
  const { path, address } = wallet.deriveAddress(i);
  console.log(`  ${path.padEnd(22)} ${address}`);
}
console.log('\n  Losing this phrase means losing every address above, permanently.\n');
