/**
 * Integration tests for the ledger invariants.
 *
 * These need a live Postgres (docker compose up -d) and are kept out of
 * `npm test` so the unit suite stays dependency-free. Run with `npm run test:db`.
 *
 * Every test runs inside a transaction that is rolled back, so the database is
 * left exactly as it was found. Deferred constraints are forced early with
 * SET CONSTRAINTS ALL IMMEDIATE, which is what a COMMIT would have triggered.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(root, '.env')); } catch {}

let client;

before(async () => {
  client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
});

after(async () => { await client?.end(); });

/** Run a body inside a transaction that is always rolled back. */
async function inRollback(body) {
  await client.query('BEGIN');
  try {
    await body();
  } finally {
    await client.query('ROLLBACK');
  }
}

/** Minimal fixtures: a merchant, a project, and the four accounts we post to. */
async function seed() {
  await client.query(`INSERT INTO merchants (id, name) VALUES ('MER_TEST', 'Test Merchant')`);
  await client.query(
    `INSERT INTO projects (id, merchant_id, name, payout_address)
     VALUES ('PRJ_TEST', 'MER_TEST', 'Test Project', 'TGW8B1V74D4MXApryznqjDSbs7PqvRtLtj')`,
  );
  await client.query(`
    INSERT INTO ledger_accounts (id, code, kind, asset, project_id) VALUES
      ('ACC_DEP_USDT', 'chain.deposits',       'asset',     'USDT', NULL),
      ('ACC_PAY_USDT', 'merchant.payable',     'liability', 'USDT', 'PRJ_TEST'),
      ('ACC_FEE_USDT', 'platform.fee_revenue', 'revenue',   'USDT', NULL),
      ('ACC_DEP_TRX',  'chain.deposits',       'asset',     'TRX',  NULL)
  `);
  await client.query(
    `INSERT INTO ledger_transactions (id, kind, memo) VALUES ('LTX_TEST', 'payment.settled', 'test')`,
  );
}

const entry = (accountId, asset, amount) =>
  client.query(
    `INSERT INTO ledger_entries (transaction_id, account_id, asset, amount_units)
     VALUES ('LTX_TEST', $1, $2, $3)`,
    [accountId, asset, amount],
  );

const flush = () => client.query('SET CONSTRAINTS ALL IMMEDIATE');

test('a balanced payment posts cleanly', async () => {
  await inRollback(async () => {
    await seed();
    // 480 USDT received, 1% fee: we hold 480, owe 475.20, keep 4.80.
    await entry('ACC_DEP_USDT', 'USDT', '480000000');
    await entry('ACC_PAY_USDT', 'USDT', '-475200000');
    await entry('ACC_FEE_USDT', 'USDT', '-4800000');
    await assert.doesNotReject(flush());
  });
});

test('the database refuses money invented out of nothing', async () => {
  await inRollback(async () => {
    await seed();
    // Credit the merchant more than actually arrived — the classic bug this
    // whole structure exists to make impossible.
    await entry('ACC_DEP_USDT', 'USDT', '480000000');
    await entry('ACC_PAY_USDT', 'USDT', '-480000001');
    await assert.rejects(flush(), /does not balance/);
  });
});

test('the database refuses money that quietly disappears', async () => {
  await inRollback(async () => {
    await seed();
    await entry('ACC_DEP_USDT', 'USDT', '480000000');
    await entry('ACC_PAY_USDT', 'USDT', '-400000000');
    await assert.rejects(flush(), /does not balance/);
  });
});

test('a single dangling entry cannot stand alone', async () => {
  await inRollback(async () => {
    await seed();
    await entry('ACC_DEP_USDT', 'USDT', '480000000');
    await assert.rejects(flush(), /does not balance/);
  });
});

test('USDT and TRX cannot be used to balance each other', async () => {
  await inRollback(async () => {
    await seed();
    // Numerically these sum to zero. Economically it is nonsense: 480 USDT is
    // not cancelled by 480 TRX. The check is per asset, so this is rejected.
    await entry('ACC_DEP_USDT', 'USDT', '480000000');
    await entry('ACC_DEP_TRX', 'TRX', '-480000000');
    await assert.rejects(flush(), /does not balance/);
  });
});

test('an entry cannot claim an asset its account does not hold', async () => {
  await inRollback(async () => {
    await seed();
    await assert.rejects(
      entry('ACC_DEP_USDT', 'TRX', '1000000'),
      /does not match account/,
    );
  });
});

test('history cannot be edited', async () => {
  await inRollback(async () => {
    await seed();
    await entry('ACC_DEP_USDT', 'USDT', '480000000');
    await entry('ACC_PAY_USDT', 'USDT', '-475200000');
    await entry('ACC_FEE_USDT', 'USDT', '-4800000');
    await flush();

    await assert.rejects(
      client.query(`UPDATE ledger_entries SET amount_units = 1 WHERE account_id = 'ACC_FEE_USDT'`),
      /append-only/,
    );
  });
});

test('history cannot be deleted', async () => {
  await inRollback(async () => {
    await seed();
    await entry('ACC_DEP_USDT', 'USDT', '480000000');
    await entry('ACC_PAY_USDT', 'USDT', '-475200000');
    await entry('ACC_FEE_USDT', 'USDT', '-4800000');
    await flush();

    await assert.rejects(
      client.query(`DELETE FROM ledger_entries WHERE account_id = 'ACC_FEE_USDT'`),
      /append-only/,
    );
  });
});

test('balances are derived from the entries, and always add to zero', async () => {
  await inRollback(async () => {
    await seed();
    await entry('ACC_DEP_USDT', 'USDT', '480000000');
    await entry('ACC_PAY_USDT', 'USDT', '-475200000');
    await entry('ACC_FEE_USDT', 'USDT', '-4800000');
    await flush();

    const { rows } = await client.query(
      `SELECT code, balance_units FROM ledger_balances
        WHERE asset = 'USDT' AND entry_count > 0 ORDER BY code`,
    );
    assert.deepEqual(rows, [
      { code: 'chain.deposits', balance_units: '480000000' },
      { code: 'merchant.payable', balance_units: '-475200000' },
      { code: 'platform.fee_revenue', balance_units: '-4800000' },
    ]);

    // The books balance overall, not just per transaction.
    const { rows: [total] } = await client.query(
      `SELECT SUM(balance_units)::TEXT AS total FROM ledger_balances WHERE asset = 'USDT'`,
    );
    assert.equal(total.total, '0');
  });
});
