/**
 * The money path: a confirmed transfer becomes a settled payment and a
 * balanced set of ledger entries.
 *
 * Transfers are injected directly rather than sent on chain, so the test runs
 * offline and deterministically. What the chain would have produced is already
 * covered by the decoder tests, which run against captured Nile blocks.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(root, '.env')); } catch {}

const { newId, newApiKey, hashApiKey, parseAmount, formatAmount } = await import('@relay/core');
const { getPool, closePool, inTransaction, createPayment, findPayment, settlePayment } =
  await import('@relay/db');
const { DepositWallet } = await import('@relay/wallet');

const usdt = (text) => parseAmount(text, 'USDT');
const wallet = DepositWallet.fromMnemonic(process.env.WALLET_MNEMONIC);

let merchantId;
let projectId;

before(async () => {
  merchantId = newId('merchant');
  projectId = newId('project');
  await inTransaction(async (client) => {
    await client.query('INSERT INTO merchants (id, name) VALUES ($1, $2)', [merchantId, 'Settle Co']);
    // 1% fee, and a webhook endpoint so deliveries get queued.
    await client.query(
      `INSERT INTO projects (id, merchant_id, name, fee_rate_bps, webhook_url)
       VALUES ($1, $2, 'Settle', 100, 'https://example.test/hook')`,
      [projectId, merchantId],
    );
  });
});

after(async () => {
  // Nothing is deleted here, and that is not laziness.
  //
  // The ledger is append-only: a trigger rejects DELETE on ledger_entries, and
  // ledger_transactions reference the payments they settled. So a teardown
  // that successfully erased these rows would be proof that the guarantee is
  // not real. Each run uses a fresh merchant and project, so the records
  // simply accumulate in the development database — which is what they would
  // do in production too.
  //
  // `npm run db:reset` drops and rebuilds the schema when that is wanted.
  await closePool();
});

const makePayment = async (amount) => {
  const { payment } = await createPayment(
    {
      projectId,
      externalRef: `S-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      asset: 'USDT',
      expectedUnits: usdt(amount),
      ttlMinutes: 15,
      requiredConfirmations: 20,
    },
    wallet,
  );
  return payment;
};

/** Pretend the chain delivered this much to the payment's address. */
const injectTransfer = (payment, amount, confirmations = 20) =>
  getPool().query(
    `INSERT INTO chain_transfers (
       tx_hash, log_index, block_number, block_time, asset,
       from_address, to_address, amount_units, confirmations, payment_id, matched_at
     ) VALUES ($1, 0, 1, now(), 'USDT', 'TSenderAddressPlaceholder000000000', $2, $3, $4, $5, now())`,
    [
      Array.from({ length: 64 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join(''),
      payment.depositAddress,
      usdt(amount).toString(),
      confirmations,
      payment.id,
    ],
  );

const ledgerFor = async (paymentId) => {
  const { rows } = await getPool().query(
    `SELECT a.code, a.project_id, e.amount_units
       FROM ledger_entries e
       JOIN ledger_accounts a ON a.id = e.account_id
       JOIN ledger_transactions t ON t.id = e.transaction_id
      WHERE t.payment_id = $1
      ORDER BY a.code`,
    [paymentId],
  );
  return rows.map((r) => ({ code: r.code, amount: BigInt(r.amount_units) }));
};

test('a confirmed payment settles and splits the money correctly', async () => {
  const payment = await makePayment('480.00');
  await injectTransfer(payment, '480.00', 20);

  const outcome = await settlePayment(payment.id);

  assert.equal(outcome.state, 'completed');
  assert.equal(outcome.changed, true);
  assert.equal(formatAmount(outcome.feeUnits, 'USDT'), '4.800000');   // 1% of 480
  assert.equal(formatAmount(outcome.netUnits, 'USDT'), '475.200000');

  const stored = await findPayment(payment.id);
  assert.equal(stored.state, 'completed');
  assert.notEqual(stored.settledAt, null);
});

test('settling writes three ledger entries that add to zero', async () => {
  const payment = await makePayment('480.00');
  await injectTransfer(payment, '480.00', 20);
  await settlePayment(payment.id);

  const entries = await ledgerFor(payment.id);
  assert.deepEqual(entries, [
    { code: 'chain.deposits', amount: usdt('480.00') },
    { code: 'merchant.payable', amount: -usdt('475.20') },
    { code: 'platform.fee_revenue', amount: -usdt('4.80') },
  ]);

  assert.equal(entries.reduce((sum, e) => sum + e.amount, 0n), 0n);
});

test('the same payment cannot be settled twice', async () => {
  // A replayed block, a restarted indexer, two workers racing: all of these
  // call settle again. Paying a merchant twice for one payment is the exact
  // failure this guards.
  const payment = await makePayment('250.00');
  await injectTransfer(payment, '250.00', 20);

  const first = await settlePayment(payment.id);
  const second = await settlePayment(payment.id);
  const third = await settlePayment(payment.id);

  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal(third.changed, false);

  const entries = await ledgerFor(payment.id);
  assert.equal(entries.length, 3, 'money was posted more than once');
});

test('an unconfirmed transfer does not settle anything', async () => {
  // Confirmations still climbing. The transfer can be orphaned, and a merchant
  // told to ship goods on one that is would be out the money.
  const payment = await makePayment('480.00');
  await injectTransfer(payment, '480.00', 3);

  const outcome = await settlePayment(payment.id);

  assert.equal(outcome.state, 'confirming');
  assert.equal(outcome.feeUnits, null);
  assert.deepEqual(await ledgerFor(payment.id), []);
});

test('a shortfall is flagged rather than settled', async () => {
  const payment = await makePayment('300.00');
  await injectTransfer(payment, '288.40', 20);

  const outcome = await settlePayment(payment.id);

  assert.equal(outcome.state, 'underpaid');
  // Nothing is credited to the merchant until a human or a top-up resolves it.
  assert.deepEqual(await ledgerFor(payment.id), []);
});

test('a top-up finishes an underpaid payment', async () => {
  const payment = await makePayment('300.00');
  await injectTransfer(payment, '288.40', 20);
  assert.equal((await settlePayment(payment.id)).state, 'underpaid');

  // The customer sends the rest.
  await injectTransfer(payment, '11.60', 20);
  const outcome = await settlePayment(payment.id);

  assert.equal(outcome.state, 'completed');
  // The fee is charged on the full 300, not on either half.
  assert.equal(formatAmount(outcome.feeUnits, 'USDT'), '3.000000');
  assert.equal(formatAmount(outcome.netUnits, 'USDT'), '297.000000');
});

test('an overpayment settles but is marked for review', async () => {
  const payment = await makePayment('900.00');
  await injectTransfer(payment, '912.00', 20);

  const outcome = await settlePayment(payment.id);

  assert.equal(outcome.state, 'overpaid');
  // The money did arrive, so it is recorded — the excess is a refund decision,
  // not a reason to leave 912 USDT unaccounted for.
  const entries = await ledgerFor(payment.id);
  assert.equal(entries.find((e) => e.code === 'chain.deposits').amount, usdt('912.00'));
  assert.equal(entries.reduce((sum, e) => sum + e.amount, 0n), 0n);
});

test('a wallet fee shaved off the top still settles in full', async () => {
  const payment = await makePayment('480.00');
  await injectTransfer(payment, '479.95', 20);

  assert.equal((await settlePayment(payment.id)).state, 'completed');
});

test('settling queues exactly one webhook', async () => {
  const payment = await makePayment('120.00');
  await injectTransfer(payment, '120.00', 20);
  await settlePayment(payment.id);
  await settlePayment(payment.id);

  const { rows } = await getPool().query(
    `SELECT event, state, attempt FROM webhook_deliveries WHERE payment_id = $1`,
    [payment.id],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event, 'payment.completed');
  assert.equal(rows[0].state, 'pending');
});

test('across many payments the books still balance', async () => {
  const amounts = ['10.00', '99.99', '1250.00', '0.05', '15000.00'];
  for (const amount of amounts) {
    const payment = await makePayment(amount);
    await injectTransfer(payment, amount, 20);
    await settlePayment(payment.id);
  }

  const { rows } = await getPool().query(
    `SELECT COALESCE(SUM(e.amount_units), 0)::text AS total
       FROM ledger_entries e
       JOIN ledger_transactions t ON t.id = e.transaction_id
       JOIN payments p ON p.id = t.payment_id
      WHERE p.project_id = $1`,
    [projectId],
  );
  assert.equal(rows[0].total, '0');
});
