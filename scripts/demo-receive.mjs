/**
 * Stand in for the customer sending money.
 *
 * Writes a chain transfer at a block the network has already buried, so the
 * indexer computes its confirmation depth from the real Nile head — the same
 * arithmetic it would do for a genuine transfer. Only the transfer itself is
 * fabricated; everything downstream of it is the real pipeline.
 *
 * Usage: node scripts/demo-receive.mjs <paymentId> <address> <amountUnits>
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import pg from 'pg';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.loadEnvFile(path.join(root, '.env'));

const [paymentId, address, amountUnits] = process.argv.slice(2);
if (!paymentId || !address || !amountUnits) {
  console.error('Usage: demo-receive.mjs <paymentId> <address> <amountUnits>');
  process.exit(1);
}

const node = process.env.TRON_FULL_NODE;
const head = (await (await fetch(`${node}/wallet/getnowblock`, { method: 'POST' })).json())
  .block_header.raw_data.number;
const block = head - 25;

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
await client.query(
  `INSERT INTO chain_transfers (
     tx_hash, log_index, block_number, block_time, asset,
     from_address, to_address, amount_units, confirmations, payment_id, matched_at
   ) VALUES ($1, 0, $2, now(), 'USDT', 'TKxUU8588Zdt44Ues3p62gULLXtgTJ2CGb', $3, $4, 0, $5, now())`,
  [randomBytes(32).toString('hex'), block, address, amountUnits, paymentId],
);
await client.end();

console.log(
  `   transfer written in block ${block} | network head ${head} | depth ${head - block + 1} blocks`,
);
