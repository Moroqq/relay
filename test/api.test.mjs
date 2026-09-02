/**
 * API tests, driven through Fastify's inject() so no port is opened.
 * Needs the containers and an applied schema: npm run test:db
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(root, '.env')); } catch {}

const { newId, newApiKey, hashApiKey } = await import('@relay/core');
const { getPool, closePool, inTransaction } = await import('@relay/db');
const { DepositWallet } = await import('@relay/wallet');
const { buildServer } = await import('../services/api/dist/server.js');

const created = { merchants: [], projects: [] };
let app;
let keyA;
let keyB;

async function makeMerchant(name) {
  const key = newApiKey(false);
  const merchantId = newId('merchant');
  const projectId = newId('project');
  await inTransaction(async (client) => {
    await client.query('INSERT INTO merchants (id, name) VALUES ($1, $2)', [merchantId, name]);
    await client.query('INSERT INTO projects (id, merchant_id, name) VALUES ($1, $2, $3)', [
      projectId, merchantId, `${name} checkout`,
    ]);
    await client.query(
      `INSERT INTO api_keys (id, project_id, label, key_prefix, key_hash)
       VALUES ($1, $2, 'test', $3, $4)`,
      [key.id, projectId, key.prefix, hashApiKey(key.secret)],
    );
  });
  created.merchants.push(merchantId);
  created.projects.push(projectId);
  return key.secret;
}

before(async () => {
  app = buildServer({
    wallet: DepositWallet.fromMnemonic(process.env.WALLET_MNEMONIC),
    requiredConfirmations: 20,
    paymentTtlMinutes: 15,
  });
  keyA = await makeMerchant(`Test A ${Date.now()}`);
  keyB = await makeMerchant(`Test B ${Date.now()}`);
});

after(async () => {
  await app?.close();
  for (const projectId of created.projects) {
    await getPool().query(
      `DELETE FROM deposit_addresses WHERE address IN
         (SELECT deposit_address FROM payments WHERE project_id = $1)`,
      [projectId],
    ).catch(() => {});
    await getPool().query('DELETE FROM payments WHERE project_id = $1', [projectId]);
  }
  for (const projectId of created.projects) {
    await getPool().query('DELETE FROM projects WHERE id = $1', [projectId]);
  }
  for (const merchantId of created.merchants) {
    await getPool().query('DELETE FROM merchants WHERE id = $1', [merchantId]);
  }
  await closePool();
});

const post = (key, payload) =>
  app.inject({
    method: 'POST',
    url: '/v1/payments',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    payload,
  });

test('creating a payment returns a fresh TRON deposit address', async () => {
  const res = await post(keyA, { amount: '480.00', asset: 'USDT', external_ref: `A-${Date.now()}` });
  assert.equal(res.statusCode, 201);

  const body = res.json();
  assert.equal(body.state, 'waiting');
  assert.equal(body.expected_amount, '480.000000');
  assert.match(body.deposit_address, /^T[1-9A-HJ-NP-Za-km-z]{33}$/);
  assert.equal(body.required_confirmations, 20);
});

test('amounts come back as strings, never JSON numbers', async () => {
  const res = await post(keyA, { amount: '90071992.547409' });
  // This value cannot survive a float round trip. As a string it is exact.
  assert.equal(res.json().expected_amount, '90071992.547409');
  assert.equal(typeof res.json().expected_amount, 'string');
});

test('a retried order returns the original payment, not a second address', async () => {
  const ref = `RETRY-${Date.now()}`;
  const first = await post(keyA, { amount: '480.00', external_ref: ref });
  const second = await post(keyA, { amount: '480.00', external_ref: ref });

  assert.equal(first.statusCode, 201);
  assert.equal(second.statusCode, 200); // 200, not 201: recognised as a repeat
  assert.equal(first.json().id, second.json().id);
  assert.equal(first.json().deposit_address, second.json().deposit_address);
});

test('simultaneous retries of one order still yield one payment', async () => {
  // The case a read-then-insert check cannot handle: ten identical requests
  // in flight at once, none of which can see the others yet.
  const ref = `RACE-${Date.now()}`;
  const responses = await Promise.all(
    Array.from({ length: 10 }, () => post(keyA, { amount: '100.00', external_ref: ref })),
  );

  const ids = new Set(responses.map((r) => r.json().id));
  assert.equal(ids.size, 1, `expected one payment, got ${ids.size}`);
  assert.equal(responses.filter((r) => r.statusCode === 201).length, 1);
});

test('every payment gets its own address', async () => {
  const responses = await Promise.all(
    Array.from({ length: 12 }, (_, i) => post(keyA, { amount: '10.00', external_ref: `U-${Date.now()}-${i}` })),
  );
  const addresses = new Set(responses.map((r) => r.json().deposit_address));
  assert.equal(addresses.size, 12);
});

test('one merchant cannot read another merchant s payment', async () => {
  const mine = await post(keyA, { amount: '55.00' });
  const id = mine.json().id;

  const res = await app.inject({
    method: 'GET',
    url: `/v1/payments/${id}`,
    headers: { authorization: `Bearer ${keyB}` },
  });

  // 404, not 403: a valid id belonging to someone else must be
  // indistinguishable from an id that does not exist, or the API becomes a
  // way to confirm which payment ids are real.
  assert.equal(res.statusCode, 404);
});

test('order references are scoped per project', async () => {
  const ref = `SHARED-${Date.now()}`;
  const a = await post(keyA, { amount: '480.00', external_ref: ref });
  const b = await post(keyB, { amount: '99.50', external_ref: ref });

  assert.equal(a.statusCode, 201);
  assert.equal(b.statusCode, 201);
  assert.notEqual(a.json().id, b.json().id);
});

test('a listing only shows the caller s own payments', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/v1/payments',
    headers: { authorization: `Bearer ${keyB}` },
  });
  const ids = res.json().data.map((p) => p.id);
  const mine = await app.inject({
    method: 'GET',
    url: '/v1/payments',
    headers: { authorization: `Bearer ${keyA}` },
  });
  for (const id of mine.json().data.map((p) => p.id)) {
    assert.ok(!ids.includes(id), `${id} leaked across projects`);
  }
});

test('requests without a valid key are rejected', async () => {
  for (const headers of [{}, { authorization: 'Bearer nope' }, { authorization: 'Basic abc' }]) {
    const res = await app.inject({ method: 'GET', url: '/v1/payments', headers });
    assert.equal(res.statusCode, 401, `should reject ${JSON.stringify(headers)}`);
  }
});

test('a revoked key stops working immediately', async () => {
  const secret = await makeMerchant(`Revoked ${Date.now()}`);
  assert.equal((await post(secret, { amount: '10.00' })).statusCode, 201);

  await getPool().query(
    'UPDATE api_keys SET revoked_at = now() WHERE key_hash = $1',
    [hashApiKey(secret)],
  );

  assert.equal((await post(secret, { amount: '10.00' })).statusCode, 401);
});

test('bad amounts are refused with an explanation', async () => {
  const cases = [
    [{ amount: 480 }, 'invalid_amount'],
    [{ amount: '0' }, 'invalid_amount'],
    [{ amount: '-5' }, 'invalid_amount'],
    [{ amount: '1.0000001' }, 'invalid_amount'],
    [{ amount: '1e3' }, 'invalid_amount'],
    [{}, 'invalid_amount'],
    [{ amount: '10', asset: 'BTC' }, 'invalid_asset'],
    [{ amount: '10', external_ref: '' }, 'invalid_external_ref'],
    [{ amount: '10', expires_in_minutes: 0 }, 'invalid_expiry'],
    [{ amount: '10', expires_in_minutes: 99999 }, 'invalid_expiry'],
  ];

  for (const [payload, expectedCode] of cases) {
    const res = await post(keyA, payload);
    assert.equal(res.statusCode, 400, `${JSON.stringify(payload)} should be rejected`);
    assert.equal(res.json().error.code, expectedCode, `wrong code for ${JSON.stringify(payload)}`);
  }
});

test('an unparseable body does not reach the handler', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/payments',
    headers: { authorization: `Bearer ${keyA}`, 'content-type': 'application/json' },
    payload: '{not json',
  });
  assert.equal(res.statusCode, 400);
});

test('health needs no credentials', async () => {
  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { status: 'ok' });
});
