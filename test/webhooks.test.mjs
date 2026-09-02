/**
 * The last link: a settled payment reaches the merchant.
 *
 * A real HTTP server runs on a real port for these tests. Mocking `fetch`
 * would prove the worker calls a function; this proves the merchant receives
 * bytes they can verify with the signature we document.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(root, '.env')); } catch {}

const { newId, parseAmount, verifySignature, SIGNATURE_HEADER, retryDelayMs } =
  await import('@relay/core');
const {
  getPool, closePool, inTransaction, createPayment, settlePayment,
  claimDueDeliveries, recordDeliveryResult,
} = await import('@relay/db');
const { DepositWallet } = await import('@relay/wallet');
const { deliver } = await import('../services/webhooks/dist/deliver.js');

const wallet = DepositWallet.fromMnemonic(process.env.WALLET_MNEMONIC);
const usdt = (text) => parseAmount(text, 'USDT');

const DEV_POLICY = { requireHttps: false, allowPrivate: true };
const OPTIONS = { timeoutMs: 3_000, policy: DEV_POLICY, userAgent: 'Relay-Webhooks/test' };
const SECRET = 'whsec_test_relay_1234567890';

/** Requests the fake merchant received. */
let received = [];
/** How the fake merchant should answer: a status, or 'hang'. */
let respondWith = 200;

let server;
let port;
let merchantId;
let projectId;

before(async () => {
  server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      received.push({
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      if (respondWith === 'hang') return; // never answers; the client must time out
      res.writeHead(respondWith, { 'Content-Type': 'text/plain' });
      res.end(respondWith >= 400 ? 'no thanks' : 'ok');
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;

  merchantId = newId('merchant');
  projectId = newId('project');
  await inTransaction(async (client) => {
    await client.query('INSERT INTO merchants (id, name) VALUES ($1, $2)', [merchantId, 'Hook Co']);
    await client.query(
      `INSERT INTO projects (id, merchant_id, name, fee_rate_bps, webhook_url, webhook_secret)
       VALUES ($1, $2, 'Hooks', 100, $3, $4)`,
      [projectId, merchantId, `http://127.0.0.1:${port}/relay/hook`, SECRET],
    );
  });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  // Ledger rows are append-only by design, so nothing is deleted here.
  await closePool();
});

/** Create a payment, pretend the chain confirmed it, settle it. */
async function settledPayment(amount = '480.00') {
  const { payment } = await createPayment(
    {
      projectId,
      externalRef: `W-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      asset: 'USDT',
      expectedUnits: usdt(amount),
      ttlMinutes: 15,
      requiredConfirmations: 20,
    },
    wallet,
  );

  await getPool().query(
    `INSERT INTO chain_transfers (
       tx_hash, log_index, block_number, block_time, asset,
       from_address, to_address, amount_units, confirmations, payment_id, matched_at
     ) VALUES ($1, 0, 1, now(), 'USDT', 'TSenderPlaceholder0000000000000000', $2, $3, 20, $4, now())`,
    [
      Array.from({ length: 64 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join(''),
      payment.depositAddress,
      usdt(amount).toString(),
      payment.id,
    ],
  );

  await settlePayment(payment.id);
  return payment;
}

/** One turn of the worker loop, scoped to this project's deliveries. */
async function runWorker() {
  const due = (await claimDueDeliveries(50)).filter((d) => d.projectId === projectId);
  const results = [];
  for (const delivery of due) {
    const result = await deliver(delivery, OPTIONS);
    results.push({ delivery, result, recorded: await recordDeliveryResult(delivery, result) });
  }
  return results;
}

const stateOf = async (paymentId) => {
  const { rows } = await getPool().query(
    'SELECT state, attempt, http_status, error FROM webhook_deliveries WHERE payment_id = $1',
    [paymentId],
  );
  return rows[0];
};

test('a settled payment reaches the merchant with a verifiable signature', async () => {
  received = [];
  respondWith = 200;

  const payment = await settledPayment('480.00');
  const [outcome] = await runWorker();

  assert.equal(outcome.recorded.state, 'delivered');
  assert.equal(outcome.result.httpStatus, 200);
  assert.equal(received.length, 1);

  const request = received[0];
  const body = JSON.parse(request.body);
  assert.equal(body.event, 'payment.completed');
  assert.equal(body.data.id, payment.id);
  assert.equal(body.data.state, 'completed');
  assert.equal(body.data.expected_amount, '480.000000');
  assert.equal(body.data.net_amount, '475.200000');
  assert.equal(body.data.fee_amount, '4.800000');

  // The merchant can prove this came from us, using exactly the function we
  // hand them as reference code.
  assert.ok(
    verifySignature(request.body, SECRET, request.headers[SIGNATURE_HEADER]),
    'signature did not verify',
  );
});

test('the signature covers the exact bytes sent', async () => {
  received = [];
  respondWith = 200;
  await settledPayment('120.00');
  await runWorker();

  const request = received[0];
  const header = request.headers[SIGNATURE_HEADER];

  // Re-serialising the parsed body produces different bytes in general, and a
  // merchant who verifies against those will fail intermittently. We sign the
  // raw body, so tampering with even one character breaks it.
  const tampered = request.body.replace('480', '999').replace('120.000000', '999.000000');
  assert.notEqual(tampered, request.body);
  assert.equal(verifySignature(tampered, SECRET, header), false);
  assert.ok(verifySignature(request.body, SECRET, header));
});

test('useful headers travel with the delivery', async () => {
  received = [];
  respondWith = 200;
  await settledPayment('75.00');
  await runWorker();

  const headers = received[0].headers;
  assert.equal(headers['relay-event'], 'payment.completed');
  assert.equal(headers['relay-attempt'], '1');
  assert.match(headers['relay-delivery'], /^WHD_/);
  assert.equal(headers['content-type'], 'application/json');
});

test('a merchant returning 502 gets retried, not abandoned', async () => {
  received = [];
  respondWith = 502;

  const payment = await settledPayment('250.00');
  const [outcome] = await runWorker();

  // The PAY_9C4D18 scenario from the design mockups.
  assert.equal(outcome.recorded.state, 'retrying');
  assert.equal(outcome.recorded.attempt, 1);
  assert.notEqual(outcome.recorded.nextAttemptAt, null);

  const stored = await stateOf(payment.id);
  assert.equal(stored.state, 'retrying');
  assert.equal(stored.http_status, 502);
});

test('the next attempt is scheduled far enough out to be useful', async () => {
  received = [];
  respondWith = 502;

  const payment = await settledPayment('250.00');
  const [outcome] = await runWorker();

  const delay = outcome.recorded.nextAttemptAt.getTime() - Date.now();
  // Thirty seconds, not thirty milliseconds: a merchant rolling back a bad
  // release needs time, and a tight loop only adds load to an endpoint that
  // is already failing.
  assert.ok(delay > 20_000, `next attempt in ${delay}ms, expected roughly ${retryDelayMs(2)}ms`);
  assert.ok(delay < 60_000);
  await stateOf(payment.id);
});

test('a merchant rejecting the payload is not retried for an hour', async () => {
  received = [];
  respondWith = 422;

  const payment = await settledPayment('99.00');
  const [outcome] = await runWorker();

  // 422 means the body is wrong. It will be just as wrong in an hour, so this
  // goes straight to the exceptions queue for a human instead.
  assert.equal(outcome.recorded.state, 'failed');
  assert.equal((await stateOf(payment.id)).state, 'failed');
});

test('retries stop after the attempt budget is spent', async () => {
  received = [];
  respondWith = 503;

  const payment = await settledPayment('42.00');

  // Five attempts, forcing each one due rather than waiting out the backoff.
  for (let i = 0; i < 5; i++) {
    await getPool().query(
      `UPDATE webhook_deliveries SET next_attempt_at = now() - interval '1 second'
        WHERE payment_id = $1`,
      [payment.id],
    );
    await runWorker();
  }

  const stored = await stateOf(payment.id);
  assert.equal(stored.state, 'failed');
  assert.equal(stored.attempt, 5);
  assert.equal(received.length, 5);
});

test('an endpoint that never answers times out instead of hanging the worker', async () => {
  received = [];
  respondWith = 'hang';

  const payment = await settledPayment('61.00');
  const startedAt = Date.now();
  const [outcome] = await runWorker();
  const elapsed = Date.now() - startedAt;

  assert.equal(outcome.result.httpStatus, null);
  assert.match(outcome.result.error, /Timed out/);
  assert.ok(elapsed < 6_000, `worker was stuck for ${elapsed}ms`);
  // No status at all means the connection failed, which is always worth
  // another try.
  assert.equal(outcome.recorded.state, 'retrying');
  respondWith = 200;
  await stateOf(payment.id);
});

test('a claimed delivery is invisible to a second worker', async () => {
  received = [];
  respondWith = 200;
  await settledPayment('33.00');

  const first = (await claimDueDeliveries(50)).filter((d) => d.projectId === projectId);
  const second = (await claimDueDeliveries(50)).filter((d) => d.projectId === projectId);

  assert.ok(first.length >= 1);
  // The lease is what stops two workers sending the same webhook twice.
  assert.equal(second.length, 0);

  for (const delivery of first) {
    await recordDeliveryResult(delivery, { httpStatus: 200, latencyMs: 5 });
  }
});
