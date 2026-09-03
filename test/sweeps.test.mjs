/**
 * Guarantees around moving settled funds out.
 *
 * Building and signing against a live node is exercised by the sweeper's own
 * tests and by running it in dry-run mode; what is checked here is the part
 * that must hold even when the network misbehaves — that money leaves an
 * address once, and that the books close when it does.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(root, '.env')); } catch {}

const { newId, parseAmount } = await import('@relay/core');
const {
  getPool, closePool, inTransaction, createPayment, settlePayment,
  planSweep, recordSigned, recordBroadcast, recordConfirmed,
  findSweepCandidates, findUnfinishedSweeps,
} = await import('@relay/db');
const { DepositWallet } = await import('@relay/wallet');

const wallet = DepositWallet.fromMnemonic(process.env.WALLET_MNEMONIC);
const usdt = (text) => parseAmount(text, 'USDT');
const PAYOUT = 'TPNnoowojVHucZZrKii9fox3Zq2MGLdXkp';

let merchantId;
let projectId;

before(async () => {
  merchantId = newId('merchant');
  projectId = newId('project');
  await inTransaction(async (client) => {
    await client.query('INSERT INTO merchants (id, name) VALUES ($1, $2)', [merchantId, 'Sweep Co']);
    await client.query(
      `INSERT INTO projects (id, merchant_id, name, fee_rate_bps, payout_address)
       VALUES ($1, $2, 'Sweeps', 100, $3)`,
      [projectId, merchantId, PAYOUT],
    );
  });
});

// Ledger rows are append-only by design, so nothing is deleted here.
after(async () => { await closePool(); });

async function settledPayment(amount) {
  const { payment } = await createPayment(
    {
      projectId,
      externalRef: `SW-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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

const candidateFor = async (paymentId) => {
  const all = await findSweepCandidates(500);
  return all.find((c) => c.paymentId === paymentId);
};

const fakeTx = () =>
  Array.from({ length: 64 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');

test('a settled payment shows up as sweepable, with the merchant s address', async () => {
  const payment = await settledPayment('480.00');
  const candidate = await candidateFor(payment.id);

  assert.ok(candidate, 'payment was not offered for sweeping');
  assert.equal(candidate.payoutAddress, PAYOUT);
  // The merchant is owed the net, not the gross: our fee never leaves with it.
  assert.equal(candidate.netUnits, usdt('475.20'));
  assert.equal(candidate.depositAddress, payment.depositAddress);
});

test('an unsettled payment is never offered for sweeping', async () => {
  const { payment } = await createPayment(
    {
      projectId, externalRef: `OPEN-${Date.now()}`, asset: 'USDT',
      expectedUnits: usdt('100'), ttlMinutes: 15, requiredConfirmations: 20,
    },
    wallet,
  );
  assert.equal(await candidateFor(payment.id), undefined);
});

test('the same funds cannot be claimed for sweeping twice', async () => {
  // Two workers reaching the same payment at the same instant is the case
  // that would otherwise send the money out twice.
  const payment = await settledPayment('250.00');
  const candidate = await candidateFor(payment.id);

  const [first, second] = await Promise.all([
    planSweep(candidate, PAYOUT),
    planSweep(candidate, PAYOUT),
  ]);

  const won = [first, second].filter((s) => s !== null);
  assert.equal(won.length, 1, 'both workers claimed the same payment');
});

test('a claimed payment disappears from the candidate list', async () => {
  const payment = await settledPayment('120.00');
  await planSweep(await candidateFor(payment.id), PAYOUT);
  assert.equal(await candidateFor(payment.id), undefined);
});

test('the signed transaction is stored before it is broadcast', async () => {
  // This ordering is what makes a crash survivable: a retry re-sends these
  // exact bytes rather than building a second transfer of the same money.
  const payment = await settledPayment('300.00');
  const sweep = await planSweep(await candidateFor(payment.id), PAYOUT);
  const txHash = fakeTx();

  await recordSigned(sweep.id, txHash, { txID: txHash, signature: ['aa'.repeat(65)] });

  const { rows } = await getPool().query(
    'SELECT state, tx_hash, signed_tx, broadcast_at FROM sweeps WHERE id = $1',
    [sweep.id],
  );
  assert.equal(rows[0].state, 'signed');
  assert.equal(rows[0].tx_hash, txHash);
  assert.ok(rows[0].signed_tx.signature);
  assert.equal(rows[0].broadcast_at, null);
});

test('an unfinished sweep is picked up again after a restart', async () => {
  const payment = await settledPayment('75.00');
  const sweep = await planSweep(await candidateFor(payment.id), PAYOUT);
  const txHash = fakeTx();
  await recordSigned(sweep.id, txHash, { txID: txHash });

  const unfinished = await findUnfinishedSweeps(500);
  assert.ok(unfinished.some((s) => s.id === sweep.id));
  // The stored bytes come back, so the retry re-broadcasts rather than rebuilds.
  assert.equal(unfinished.find((s) => s.id === sweep.id).txHash, txHash);
});

test('confirming a sweep settles what we owed the merchant', async () => {
  const payment = await settledPayment('480.00');
  const sweep = await planSweep(await candidateFor(payment.id), PAYOUT);
  const txHash = fakeTx();
  await recordSigned(sweep.id, txHash, { txID: txHash });
  await recordBroadcast(sweep.id);

  // Before: we hold the gross and owe the merchant the net.
  const before = await payableFor(payment.id);
  assert.equal(before, -usdt('475.20'));

  await recordConfirmed(sweep.id, 163_020n, 30_000n);

  // After: the debt is discharged, because the money is in their wallet.
  const after = await payableFor(payment.id);
  assert.equal(after, 0n);
});

async function payableFor(paymentId) {
  const { rows } = await getPool().query(
    `SELECT COALESCE(SUM(e.amount_units), 0)::text AS total
       FROM ledger_entries e
       JOIN ledger_accounts a ON a.id = e.account_id
       JOIN ledger_transactions t ON t.id = e.transaction_id
      WHERE t.payment_id = $1 AND a.code = 'merchant.payable'`,
    [paymentId],
  );
  return BigInt(rows[0].total);
}

test('the payout and the network fee are booked separately, each balancing', async () => {
  const payment = await settledPayment('600.00');
  const sweep = await planSweep(await candidateFor(payment.id), PAYOUT);
  const txHash = fakeTx();
  await recordSigned(sweep.id, txHash, { txID: txHash });
  await recordConfirmed(sweep.id, 163_020n, 30_000n);

  const { rows } = await getPool().query(
    `SELECT t.kind, a.code, a.asset, e.amount_units
       FROM ledger_entries e
       JOIN ledger_accounts a ON a.id = e.account_id
       JOIN ledger_transactions t ON t.id = e.transaction_id
      WHERE t.payment_id = $1 AND t.kind IN ('payout.sent', 'gas.spent')
      ORDER BY t.kind, a.code`,
    [payment.id],
  );

  const payout = rows.filter((r) => r.kind === 'payout.sent');
  const gas = rows.filter((r) => r.kind === 'gas.spent');

  // USDT and TRX cannot offset each other, so they are two transactions.
  assert.equal(payout.length, 2);
  assert.ok(payout.every((r) => r.asset === 'USDT'));
  assert.equal(payout.reduce((sum, r) => sum + BigInt(r.amount_units), 0n), 0n);

  assert.equal(gas.length, 2);
  assert.ok(gas.every((r) => r.asset === 'TRX'));
  assert.equal(gas.reduce((sum, r) => sum + BigInt(r.amount_units), 0n), 0n);
  assert.equal(
    BigInt(gas.find((r) => r.code === 'platform.gas_expense').amount_units),
    163_020n,
  );
});

test('confirming twice does not book the payout twice', async () => {
  // A reconciliation pass that runs again over a sweep it already booked must
  // not pay the merchant down a second time.
  const payment = await settledPayment('150.00');
  const sweep = await planSweep(await candidateFor(payment.id), PAYOUT);
  const txHash = fakeTx();
  await recordSigned(sweep.id, txHash, { txID: txHash });

  await recordConfirmed(sweep.id, 163_020n, 30_000n);
  await recordConfirmed(sweep.id, 163_020n, 30_000n);
  await recordConfirmed(sweep.id, 163_020n, 30_000n);

  const { rows } = await getPool().query(
    `SELECT COUNT(*)::int AS n FROM ledger_transactions
      WHERE payment_id = $1 AND kind = 'payout.sent'`,
    [payment.id],
  );
  assert.equal(rows[0].n, 1);
  assert.equal(await payableFor(payment.id), 0n);
});

test('a sweep with no fee books no gas entry', async () => {
  // Delegated energy costs nothing at the moment of use, and a zero entry is
  // clutter in a statement rather than information.
  const payment = await settledPayment('90.00');
  const sweep = await planSweep(await candidateFor(payment.id), PAYOUT);
  const txHash = fakeTx();
  await recordSigned(sweep.id, txHash, { txID: txHash });
  await recordConfirmed(sweep.id, 0n, 0n);

  const { rows } = await getPool().query(
    `SELECT COUNT(*)::int AS n FROM ledger_transactions
      WHERE payment_id = $1 AND kind = 'gas.spent'`,
    [payment.id],
  );
  assert.equal(rows[0].n, 0);
});

test('a sweep cannot claim to be signed without the bytes to prove it', async () => {
  // The schema refuses it: a signed sweep with no transaction is one that
  // cannot be safely retried.
  const payment = await settledPayment('60.00');
  const sweep = await planSweep(await candidateFor(payment.id), PAYOUT);

  await assert.rejects(
    getPool().query(`UPDATE sweeps SET state = 'signed' WHERE id = $1`, [sweep.id]),
    /sweeps_signed_has_transaction/,
  );
});

test('two sweeps cannot share a transaction id', async () => {
  const first = await settledPayment('45.00');
  const second = await settledPayment('55.00');
  const a = await planSweep(await candidateFor(first.id), PAYOUT);
  const b = await planSweep(await candidateFor(second.id), PAYOUT);

  const txHash = fakeTx();
  await recordSigned(a.id, txHash, { txID: txHash });
  await assert.rejects(
    recordSigned(b.id, txHash, { txID: txHash }),
    /sweeps_tx_hash_key/,
  );
});
