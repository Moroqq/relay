/**
 * Drop and rebuild the schema. Development only.
 *
 * The ledger is deliberately impossible to delete from, so there is no gentle
 * way to clear accumulated test data — the whole schema goes. This refuses to
 * run against anything that looks like production.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(root, '.env')); } catch {}

const url = process.env.DATABASE_URL ?? '';
if (!/localhost|127\.0\.0\.1/.test(url)) {
  console.error('Refusing to reset a database that is not on localhost.');
  process.exit(1);
}
if (process.env.TRON_NETWORK === 'mainnet') {
  console.error('Refusing to reset while TRON_NETWORK is mainnet.');
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
await client.end();
console.log('Schema dropped. Run "npm run db:migrate" to rebuild it.');
