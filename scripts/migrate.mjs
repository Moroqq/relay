/**
 * Migration runner.
 *
 * Plain .sql files applied in filename order, each inside its own transaction,
 * each recorded with a checksum. No ORM: on a system that moves money, the SQL
 * that actually ran should be readable in the repository without a translation
 * layer in between.
 *
 * A changed checksum on an already-applied file is a hard error. Editing a
 * migration that has run on any other machine silently desynchronises schemas.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

try {
  process.loadEnvFile(path.join(root, '.env'));
} catch {
  // No .env — fall back to whatever is already in the environment.
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env first.');
  process.exit(1);
}

const client = new pg.Client({ connectionString });
await client.connect();

await client.query(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename    TEXT PRIMARY KEY,
    checksum    TEXT NOT NULL,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`);

const dir = path.join(root, 'db', 'migrations');
const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

const { rows: applied } = await client.query('SELECT filename, checksum FROM schema_migrations');
const appliedByName = new Map(applied.map((r) => [r.filename, r.checksum]));

let ran = 0;

for (const filename of files) {
  const sql = await readFile(path.join(dir, filename), 'utf8');
  const checksum = createHash('sha256').update(sql).digest('hex').slice(0, 16);
  const previous = appliedByName.get(filename);

  if (previous !== undefined) {
    if (previous !== checksum) {
      console.error(
        `\n  ${filename} has been edited since it was applied.` +
          `\n  Recorded ${previous}, file is now ${checksum}.` +
          `\n  Add a new migration instead of changing this one.\n`,
      );
      await client.end();
      process.exit(1);
    }
    console.log(`  = ${filename}`);
    continue;
  }

  process.stdout.write(`  + ${filename} ... `);
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [
      filename,
      checksum,
    ]);
    await client.query('COMMIT');
    console.log('ok');
    ran += 1;
  } catch (error) {
    await client.query('ROLLBACK');
    console.log('FAILED');
    console.error(`\n${error.message}\n`);
    if (error.position) console.error(`  at character ${error.position}`);
    await client.end();
    process.exit(1);
  }
}

console.log(ran === 0 ? '\n  Schema already up to date.\n' : `\n  Applied ${ran} migration(s).\n`);
await client.end();
