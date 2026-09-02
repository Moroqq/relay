/**
 * Integration tests for the guarantees the payments table enforces by itself,
 * independently of any application code that might be bypassed.
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

async function inRollback(body) {
  await client.query('BEGIN');
  try { await body(); } finally { await client.query('ROLLBACK'); }
}

async function seed() {
  await client.query(`INSERT INTO merchants (id, name) VALUES ('MER_T', 'T')`);
  await client.query(`INSERT INTO projects (id, merchant_id, name) VALUES ('PRJ_T', 'MER_T', 'T')`);
  await client.query(`
    INSERT INTO deposit_addresses (address, derivation_index, derivation_path) VALUES
      ('TGW8B1V74D4MXApryznqjDSbs7PqvRtLtj', 0, 'm/44''/195''/0''/0/0'),
      ('TGvPpdz2mipjvsVuyZqMFJ62VCeS9LGVLK', 1, 'm/44''/195''/0''/0/1')
  `);
}

const insertPayment = (id, address, extras = {}) => {
  const { externalRef = null, state = 'waiting', fee = null, net = null } = extras;
  return client.query(
    `INSERT INTO payments (
       id, project_id, external_ref, asset, expected_units, state, deposit_address,
       required_confirmations, fee_rate_bps, fee_flat_units,
       tolerance_under_bps, tolerance_under_floor, tolerance_over_bps, tolerance_over_floor,
       fee_units, net_units, expires_at
     ) VALUES ($1, 'PRJ_T', $2, 'USDT', 480000000, $3, $4,
       20, 100, 0, 50, 100000, 50, 100000, $5, $6, now() + interval '15 minutes')`,
    [id, externalRef, state, address, fee, net],
  );
};

const A0 = 'TGW8B1V74D4MXApryznqjDSbs7PqvRtLtj';
const A1 = 'TGvPpdz2mipjvsVuyZqMFJ62VCeS9LGVLK';

test('a retried create cannot produce a second payment for the same order', async () => {
  await inRollback(async () => {
    await seed();
    await insertPayment('PAY_001', A0, { externalRef: 'ORD-11902' });
    // The merchant's HTTP client timed out and retried. Without this
    // constraint they would get a second address and a confused customer.
    await assert.rejects(
      insertPayment('PAY_002', A1, { externalRef: 'ORD-11902' }),
      /payments_project_ref_idx/,
    );
  });
});

test('two payments cannot share a deposit address', async () => {
  await inRollback(async () => {
    await seed();
    await insertPayment('PAY_001', A0);
    // Reuse would make two equal transfers to that address indistinguishable.
    await assert.rejects(insertPayment('PAY_002', A0), /payments_deposit_address_key/);
  });
});

test('payments without an order reference are not deduplicated', async () => {
  await inRollback(async () => {
    await seed();
    // The partial index must not treat two NULLs as a collision.
    await insertPayment('PAY_001', A0);
    await assert.doesNotReject(insertPayment('PAY_002', A1));
  });
});

test('a settled payment cannot exist without its fee split recorded', async () => {
  await inRollback(async () => {
    await seed();
    await assert.rejects(
      insertPayment('PAY_001', A0, { state: 'completed' }),
      /payments_split_matches_state/,
    );
  });
});

test('an unsettled payment cannot claim a fee split', async () => {
  await inRollback(async () => {
    await seed();
    await assert.rejects(
      insertPayment('PAY_001', A0, { state: 'waiting', fee: '4800000', net: '475200000' }),
      /payments_split_matches_state/,
    );
  });
});

test('a settled payment with its split is accepted', async () => {
  await inRollback(async () => {
    await seed();
    await assert.doesNotReject(
      insertPayment('PAY_001', A0, { state: 'completed', fee: '4800000', net: '475200000' }),
    );
  });
});

test('a payment cannot expect zero or a negative amount', async () => {
  await inRollback(async () => {
    await seed();
    for (const bad of ['0', '-1']) {
      // Each attempt gets its own savepoint: a failed statement poisons the
      // whole transaction in Postgres, so the second check would otherwise
      // report "transaction is aborted" instead of the constraint under test.
      await client.query('SAVEPOINT attempt');
      await assert.rejects(
        client.query(
          `INSERT INTO payments (id, project_id, asset, expected_units, deposit_address,
             required_confirmations, fee_rate_bps, fee_flat_units, tolerance_under_bps,
             tolerance_under_floor, tolerance_over_bps, tolerance_over_floor, expires_at)
           VALUES ('PAY_BAD', 'PRJ_T', 'USDT', $1, $2, 20, 100, 0, 50, 100000, 50, 100000,
             now() + interval '15 minutes')`,
          [bad, A0],
        ),
        /violates check constraint/,
        `should reject expected_units = ${bad}`,
      );
      await client.query('ROLLBACK TO SAVEPOINT attempt');
    }
  });
});

test('an unknown state cannot be written at all', async () => {
  await inRollback(async () => {
    await seed();
    // The enum is the schema's copy of the state machine in @relay/core.
    await assert.rejects(insertPayment('PAY_001', A0, { state: 'webhook_failed' }), /invalid input value/);
  });
});
