/**
 * Consolidating user addresses into the treasury.
 *
 * The bookkeeping question these tests exist to pin down: the funds move
 * between two accounts we control, so the merchant is still owed every cent
 * afterwards. A sweep that cleared that debt would make the books show us
 * owing nothing while holding somebody else's money.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(root, '.env')); } catch {}

const { newId, parseAmount } = await import('@relay/core');
const {
  getPool, closePool, inTransaction,
  ensureEndUser, recordDeposit, creditDeposit,
  findUserSweepCandidates, planUserSweep, recordSigned, recordUserSweepConfirmed,
} = await import('@relay/db');
const { DepositWallet } = await import('@relay/wallet');

const wallet = DepositWallet.fromMnemonic(process.env.WALLET_MNEMONIC);
const usdt = (t) => parseAmount(t, 'USDT');
const TREASURY = 'TPNnoowojVHucZZrKii9fox3Zq2MGLdXkp';
const hash = () => randomBytes(32).toString('hex');

let merchantId;
let projectId;

before(async () => {
  merchantId = newId('merchant');
  projectId = newId('project');
  await inTransaction(async (client) => {
    await client.query('INSERT INTO merchants (id, name) VALUES ($1, $2)', [merchantId, 'Consolidate Co']);
    await client.query(
      `INSERT INTO projects (id, merchant_id, name, fee_rate_bps) VALUES ($1, $2, 'Wallets', 100)`,
      [projectId, merchantId],
    );
  });
});

// The ledger is append-only by design, so nothing is deleted here.
after(async () => { await closePool(); });

const newRef = () => `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** A user with `amounts` already credited on their address. */
async function userWithDeposits(amounts) {
  const { user } = await ensureEndUser(projectId, newRef(), wallet);
  for (const amount of amounts) {
    const d = await recordDeposit(
      {
        toAddress: user.depositAddress,
        asset: 'USDT',
        amountUnits: usdt(amount),
        txHash: hash(),
        logIndex: 0,
        blockNumber: 500,
      },
      20,
    );
    await creditDeposit(d.id, 20);
  }
  return user;
}

const candidateFor = async (userId) =>
  (await findUserSweepCandidates(1_000_000)).find((c) => c.endUserId === userId);

const payableFor = async () => {
  const { rows } = await getPool().query(
    `SELECT COALESCE(SUM(e.amount_units), 0)::text AS total
       FROM ledger_entries e
       JOIN ledger_accounts a ON a.id = e.account_id
      WHERE a.code = 'merchant.payable' AND a.project_id = $1`,
    [projectId],
  );
  return BigInt(rows[0].total);
};

const entriesFor = async (sweepId, kind) => {
  const { rows } = await getPool().query(
    `SELECT a.code, a.asset, e.amount_units
       FROM ledger_entries e
       JOIN ledger_accounts a ON a.id = e.account_id
       JOIN ledger_transactions t ON t.id = e.transaction_id
      WHERE t.kind = $2 AND t.memo LIKE '%' || (SELECT from_address FROM sweeps WHERE id = $1) || '%'
      ORDER BY a.code`,
    [sweepId, kind],
  );
  return rows.map((r) => ({ code: r.code, asset: r.asset, amount: BigInt(r.amount_units) }));
};

test('a credited deposit puts its address in the sweep queue', async () => {
  const user = await userWithDeposits(['250.00']);
  const candidate = await candidateFor(user.id);

  assert.ok(candidate, 'address was not offered for sweeping');
  assert.equal(candidate.depositAddress, user.depositAddress);
  assert.equal(candidate.pendingUnits, usdt('250.00'));
  assert.equal(candidate.depositCount, 1);
});

test('an uncredited deposit is not swept', async () => {
  const { user } = await ensureEndUser(projectId, newRef(), wallet);
  const d = await recordDeposit(
    { toAddress: user.depositAddress, asset: 'USDT', amountUnits: usdt('99.00'),
      txHash: hash(), logIndex: 0, blockNumber: 500 },
    20,
  );
  await creditDeposit(d.id, 3); // still confirming

  assert.equal(await candidateFor(user.id), undefined);
});

test('several top-ups on one address become one sweep', async () => {
  // The saving the account model actually delivers: a user who topped up
  // three times is emptied once.
  const user = await userWithDeposits(['10.00', '25.50', '100.00']);
  const candidate = await candidateFor(user.id);

  assert.equal(candidate.depositCount, 3);
  assert.equal(candidate.pendingUnits, usdt('135.50'));
});

test('an address can only have one sweep in flight', async () => {
  // Two signed transfers of the same funds means one of them fails on chain
  // after its fee has been paid.
  const user = await userWithDeposits(['80.00']);
  const candidate = await candidateFor(user.id);

  const [a, b] = await Promise.all([
    planUserSweep(candidate, TREASURY, candidate.pendingUnits),
    planUserSweep(candidate, TREASURY, candidate.pendingUnits),
  ]);

  assert.equal([a, b].filter((s) => s !== null).length, 1);
});

test('an address with a sweep in flight leaves the queue', async () => {
  const user = await userWithDeposits(['60.00']);
  const candidate = await candidateFor(user.id);
  await planUserSweep(candidate, TREASURY, candidate.pendingUnits);

  assert.equal(await candidateFor(user.id), undefined);
});

test('confirming moves the money between our own accounts', async () => {
  const user = await userWithDeposits(['480.00']);
  const candidate = await candidateFor(user.id);
  const sweep = await planUserSweep(candidate, TREASURY, candidate.pendingUnits);
  const tx = hash();
  await recordSigned(sweep.id, tx, { txID: tx });

  const result = await recordUserSweepConfirmed(sweep.id, 0n, 64_285n);
  assert.equal(result.depositsSettled, 1);

  const entries = await entriesFor(sweep.id, 'sweep.consolidated');
  assert.deepEqual(entries, [
    { code: 'chain.deposits', asset: 'USDT', amount: -usdt('480.00') },
    { code: 'chain.treasury', asset: 'USDT', amount: usdt('480.00') },
  ]);
  assert.equal(entries.reduce((s, e) => s + e.amount, 0n), 0n);
});

test('sweeping does NOT clear what we owe the merchant', async () => {
  // The custodial consequence, stated as a test. Funds moved between two
  // accounts we control; the merchant is owed exactly what they were owed
  // before. Clearing it here would show us owing nothing while holding
  // somebody else's money.
  const before = await payableFor();

  const user = await userWithDeposits(['300.00']);
  const afterCredit = await payableFor();
  // Crediting the deposit created the debt: 300 less our 1%.
  assert.equal(afterCredit - before, -usdt('297.00'));

  const candidate = await candidateFor(user.id);
  const sweep = await planUserSweep(candidate, TREASURY, candidate.pendingUnits);
  const tx = hash();
  await recordSigned(sweep.id, tx, { txID: tx });
  await recordUserSweepConfirmed(sweep.id, 0n, 64_285n);

  // And the sweep left it exactly where it was.
  assert.equal(await payableFor(), afterCredit);
});

test('the network fee is booked in TRX, separately', async () => {
  const user = await userWithDeposits(['200.00']);
  const candidate = await candidateFor(user.id);
  const sweep = await planUserSweep(candidate, TREASURY, candidate.pendingUnits);
  const tx = hash();
  await recordSigned(sweep.id, tx, { txID: tx });
  await recordUserSweepConfirmed(sweep.id, 163_020n, 64_285n);

  const gas = await entriesFor(sweep.id, 'gas.spent');
  assert.equal(gas.length, 2);
  assert.ok(gas.every((e) => e.asset === 'TRX'));
  assert.equal(gas.reduce((s, e) => s + e.amount, 0n), 0n);
});

test('a sweep that cost nothing books no gas entry', async () => {
  // What the observed operator's receipts actually show: energy supplied in
  // advance, bandwidth inside the free daily allowance, zero TRX.
  const user = await userWithDeposits(['150.00']);
  const candidate = await candidateFor(user.id);
  const sweep = await planUserSweep(candidate, TREASURY, candidate.pendingUnits);
  const tx = hash();
  await recordSigned(sweep.id, tx, { txID: tx });
  await recordUserSweepConfirmed(sweep.id, 0n, 64_285n);

  assert.deepEqual(await entriesFor(sweep.id, 'gas.spent'), []);
});

test('confirming twice does not move the money twice', async () => {
  const user = await userWithDeposits(['90.00']);
  const candidate = await candidateFor(user.id);
  const sweep = await planUserSweep(candidate, TREASURY, candidate.pendingUnits);
  const tx = hash();
  await recordSigned(sweep.id, tx, { txID: tx });

  const first = await recordUserSweepConfirmed(sweep.id, 0n, 64_285n);
  const second = await recordUserSweepConfirmed(sweep.id, 0n, 64_285n);

  assert.equal(first.depositsSettled, 1);
  assert.equal(second, null);
  assert.equal((await entriesFor(sweep.id, 'sweep.consolidated')).length, 2);
});

test('a swept address returns to the queue when the user tops up again', async () => {
  // A permanent address is emptied repeatedly over its life, which is the
  // whole difference from the single-use addresses of the invoice model.
  const user = await userWithDeposits(['50.00']);
  const first = await candidateFor(user.id);
  const sweep = await planUserSweep(first, TREASURY, first.pendingUnits);
  const tx = hash();
  await recordSigned(sweep.id, tx, { txID: tx });
  await recordUserSweepConfirmed(sweep.id, 0n, 64_285n);

  assert.equal(await candidateFor(user.id), undefined, 'nothing left to sweep');

  const d = await recordDeposit(
    { toAddress: user.depositAddress, asset: 'USDT', amountUnits: usdt('70.00'),
      txHash: hash(), logIndex: 0, blockNumber: 600 },
    20,
  );
  await creditDeposit(d.id, 20);

  const again = await candidateFor(user.id);
  assert.ok(again, 'address did not come back for the second top-up');
  // Only the new money — the first sweep's deposits are stamped and excluded.
  assert.equal(again.pendingUnits, usdt('70.00'));
});
