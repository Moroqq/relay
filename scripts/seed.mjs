/**
 * Create a merchant, a project and an API key for local development.
 *
 * The API key secret is printed once and never again — only its hash is
 * stored, which is the same guarantee a real merchant gets.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newId, newApiKey, hashApiKey } from '@relay/core';
import { getPool, closePool, inTransaction } from '@relay/db';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(root, '.env')); } catch {}

const merchantName = process.argv[2] ?? 'Marketplace B';
const projectName = process.argv[3] ?? 'Checkout';

const key = newApiKey(process.env.TRON_NETWORK === 'mainnet');

const { merchantId, projectId } = await inTransaction(async (client) => {
  const merchantId = newId('merchant');
  const projectId = newId('project');

  await client.query('INSERT INTO merchants (id, name) VALUES ($1, $2)', [merchantId, merchantName]);

  await client.query(
    `INSERT INTO projects (id, merchant_id, name, payout_address, webhook_url, webhook_secret)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      projectId,
      merchantId,
      projectName,
      null,
      'http://127.0.0.1:4001/relay/hook',
      'whsec_' + newId('project').slice(4).toLowerCase(),
    ],
  );

  await client.query(
    `INSERT INTO api_keys (id, project_id, label, key_prefix, key_hash)
     VALUES ($1, $2, $3, $4, $5)`,
    [key.id, projectId, 'local development', key.prefix, hashApiKey(key.secret)],
  );

  return { merchantId, projectId };
});

const { rows } = await getPool().query(
  'SELECT fee_rate_bps, fee_flat_units FROM projects WHERE id = $1',
  [projectId],
);

console.log(`
  Merchant   ${merchantName}  (${merchantId})
  Project    ${projectName}  (${projectId})
  Pricing    ${Number(rows[0].fee_rate_bps) / 100}% + ${Number(rows[0].fee_flat_units) / 1e6} USDT

  API key    ${key.secret}

  This secret is shown once. Only its hash is stored.
`);

await closePool();
