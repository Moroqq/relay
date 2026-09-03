/**
 * Stand in for a user topping up their balance.
 *
 * Records the deposit at a block the network has already buried, so the
 * indexer computes its confirmation depth from the real chain head — the same
 * arithmetic it does for a genuine transfer. Only the transfer itself is
 * fabricated; detection, confirmation, crediting and notification are the
 * real pipeline.
 *
 * Usage: node scripts/demo-topup.mjs <depositAddress> <amount>
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { parseAmount, formatAmount } from '@relay/core';
import { recordDeposit, closePool } from '@relay/db';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.loadEnvFile(path.join(root, '.env'));

const [address, amount] = process.argv.slice(2);
if (!address || !amount) {
  console.error('Usage: demo-topup.mjs <depositAddress> <amount>');
  process.exit(1);
}

const head = (
  await (await fetch(`${process.env.TRON_FULL_NODE}/wallet/getnowblock`, { method: 'POST' })).json()
).block_header.raw_data.number;
const block = head - 25;

const units = parseAmount(amount, 'USDT');
const deposit = await recordDeposit(
  {
    toAddress: address,
    asset: 'USDT',
    amountUnits: units,
    txHash: randomBytes(32).toString('hex'),
    logIndex: 0,
    blockNumber: block,
  },
  Number(process.env.CONFIRMATIONS_REQUIRED ?? 20),
);

if (deposit === null) {
  console.error('   no user owns that address, or the transfer was already recorded');
  process.exit(1);
}

console.log(
  `   ${deposit.id}  ${formatAmount(units, 'USDT', { trimTrailingZeros: true })} USDT` +
    `  block ${block}, head ${head}, depth ${head - block + 1}`,
);

await closePool();
