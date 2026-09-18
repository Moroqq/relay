/**
 * Sending payouts, and the three bugs found while building it.
 *
 * 1. Two workers could each store a different signed transaction for the same
 *    payout and both broadcast — the merchant paid twice.
 * 2. A dry run left sweeps in flight forever, blocking their addresses.
 * 3. A sweep that failed before signing stayed planned forever, likewise.
 *
 * Plus the ledger side of the hot wallet: refills from the treasury have to be
 * booked, or the hot wallet's account only ever goes down.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(root, '.env')); } catch {}

const { newId, parseAmount } = await import('@relay/core');
const db = await import('@relay/db');
const { DepositWallet } = await import('@relay/wallet');

const wallet = DepositWallet.fromMnemonic(process.env.WALLET_MNEMONIC);
const usdt = (t) => parseAmount(t, 'USDT');
const hash = () => randomBytes(32).toString('hex');

const MERCHANT_WALLET = 'TKxUU8588Zdt44Ues3p62gULLXtgTJ2CGb';
const WALLETS = {
  treasury: 'TPNnoowojVHucZZrKii9fox3Zq2MGLdXkp',
  hotWallet: 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf',
};

let projectId;

before(async () => {
  const merchantId = newId('merchant');
  projectId = newId('project');
  await db.inTransaction(async (client) => {
    await client.query('INSERT INTO merchants (id, name) VALUES ($1, $2)', [merchantId, 'Exec Co']);
    await client.query(
      `INSERT INTO projects (id, merchant_id, name, fee_rate_bps) VALUES ($1, $2, 'Exec', 100)`,
      [projectId, merchantId],
    );
  });
});

// The ledger is append-only by design, so nothing is deleted here.
after(async () => { await db.closePool(); });

async function credit(amount) {
  const { user } = await db.ensureEndUser(projectId, `x-${hash().slice(0, 12)}`, wallet);
  const d = await db.recordDeposit(
    { toAddress: user.depositAddress, asset: 'USDT', amountUnits: usdt(amount),
      txHash: hash(), logIndex: 0, blockNumber: 900 },
    20,
  );
  await db.creditDeposit(d.id, 20);
  return user;
}

async function approvedPayout(amount) {
  await credit((Number(amount) * 1.2).toFixed(2));
  const { payout } = await db.requestPayout({
    projectId, externalRef: null, asset: 'USDT', amountUnits: usdt(amount), toAddress: MERCHANT_WALLET,
  });
  return db.approvePayout(payout.id, 'operator');
}

const reload = (id) => db.findPayout(id);

test('two workers signing the same payout: exactly one gets to broadcast', async () => {
  // The double-payment bug. Each worker signs its own transaction — TRON's id
  // covers a timestamp, so they differ — and the first version let the second
  // overwrite the first while both went on to broadcast.
  const payout = await approvedPayout('100.00');
  const txA = hash();
  const txB = hash();

  const [a, b] = await Promise.all([
    db.recordPayoutSigned(payout.id, txA, { txID: txA }, WALLETS.hotWallet),
    db.recordPayoutSigned(payout.id, txB, { txID: txB }, WALLETS.hotWallet),
  ]);

  assert.equal([a, b].filter(Boolean).length, 1, 'both workers believed they won');

  // And the stored transaction is the winner's, untouched by the loser.
  const stored = await reload(payout.id);
  assert.equal(stored.txHash, a ? txA : txB);
});

test('a payout that is not approved cannot be claimed for signing', async () => {
  await credit('200.00');
  const { payout } = await db.requestPayout({
    projectId, externalRef: null, asset: 'USDT', amountUnits: usdt('50.00'), toAddress: MERCHANT_WALLET,
  });
  assert.equal(payout.state, 'requested');

  const tx = hash();
  assert.equal(await db.recordPayoutSigned(payout.id, tx, { txID: tx }, WALLETS.hotWallet), false);
});

test('a signed payout records which wallet signed it', async () => {
  const payout = await approvedPayout('40.00');
  const tx = hash();
  await db.recordPayoutSigned(payout.id, tx, { txID: tx }, WALLETS.hotWallet);
  assert.equal((await reload(payout.id)).fromAddress, WALLETS.hotWallet);
});

test('an expired payout goes back to approved and can be signed afresh', async () => {
  const payout = await approvedPayout('60.00');
  const before = await db.readMerchantBalance(projectId);

  const first = hash();
  await db.recordPayoutSigned(payout.id, first, { txID: first }, WALLETS.hotWallet);
  assert.equal(await db.resetExpiredPayout(payout.id, 'expired'), true);

  const reset = await reload(payout.id);
  assert.equal(reset.state, 'approved');
  assert.equal(reset.txHash, null);

  // The reservation never lapsed: at no point could this money be requested twice.
  assert.equal((await db.readMerchantBalance(projectId)).reservedUnits, before.reservedUnits);

  const second = hash();
  assert.equal(await db.recordPayoutSigned(payout.id, second, { txID: second }, WALLETS.hotWallet), true);
});

test('a completed payout can never be reset or failed', async () => {
  const payout = await approvedPayout('30.00');
  const tx = hash();
  await db.recordPayoutSigned(payout.id, tx, { txID: tx }, WALLETS.hotWallet);
  await db.recordPayoutCompleted(payout.id, 0n);

  assert.equal(await db.resetExpiredPayout(payout.id, 'no'), false);
  assert.equal(await db.markPayoutFailed(payout.id, 'no'), false);
  assert.equal((await reload(payout.id)).state, 'completed');
});

test('a payout that failed on chain releases its reservation', async () => {
  const payout = await approvedPayout('70.00');
  const reserved = (await db.readMerchantBalance(projectId)).reservedUnits;

  const tx = hash();
  await db.recordPayoutSigned(payout.id, tx, { txID: tx }, WALLETS.hotWallet);
  await db.markPayoutFailed(payout.id, 'reverted on chain: REVERT');

  const after = await db.readMerchantBalance(projectId);
  assert.equal(reserved - after.reservedUnits, usdt('70.00'));
});

// --- sweeps that used to block their address forever -------------------------

const userCandidate = async (userId) =>
  (await db.findUserSweepCandidates(500)).find((c) => c.endUserId === userId);

test('a sweep that fails before signing releases its address', async () => {
  // A node timeout while building used to leave the sweep planned forever,
  // and a planned sweep holds its address — so the address was never swept
  // again and the user's money sat there with nothing able to move it.
  const user = await credit('90.00');
  const candidate = await userCandidate(user.id);
  const sweep = await db.planUserSweep(candidate, WALLETS.treasury, candidate.pendingUnits);

  assert.equal(await userCandidate(user.id), undefined, 'address should be held while in flight');

  await db.recordFailure(sweep.id, 'node timed out while building');

  assert.ok(await userCandidate(user.id), 'address was not released after the failure');
});

test('a sweep that fails after signing keeps its bytes until they provably expire', async () => {
  // Those bytes might still land. Releasing the address now would let a
  // second sweep be signed for funds the first may yet move.
  const user = await credit('80.00');
  const candidate = await userCandidate(user.id);
  const sweep = await db.planUserSweep(candidate, WALLETS.treasury, candidate.pendingUnits);
  const tx = hash();
  await db.recordSigned(sweep.id, tx, { txID: tx });

  await db.recordFailure(sweep.id, 'broadcast returned SERVER_BUSY');
  assert.equal(await userCandidate(user.id), undefined, 'address released while bytes may still land');

  // Once expiry has passed and the chain has no record, it is released.
  assert.equal(await db.expireSweep(sweep.id, 'expired without landing'), true);
  assert.ok(await userCandidate(user.id));
});

test('a payment whose sweep failed can be swept again', async () => {
  // The one-sweep-per-payment index used to count failed rows, so a single
  // failure stranded the payment's funds permanently.
  const { payment } = await db.createPayment(
    { projectId, externalRef: `p-${hash().slice(0, 10)}`, asset: 'USDT',
      expectedUnits: usdt('150.00'), ttlMinutes: 15, requiredConfirmations: 20 },
    wallet,
  );
  await db.getPool().query(
    `UPDATE projects SET payout_address = $2 WHERE id = $1`, [projectId, MERCHANT_WALLET]);
  await db.getPool().query(
    `INSERT INTO chain_transfers (tx_hash, log_index, block_number, block_time, asset,
       from_address, to_address, amount_units, confirmations, payment_id, matched_at)
     VALUES ($1, 0, 1, now(), 'USDT', $2, $3, $4, 20, $5, now())`,
    [hash(), MERCHANT_WALLET, payment.depositAddress, usdt('150.00').toString(), payment.id],
  );
  await db.settlePayment(payment.id);

  const find = async () => (await db.findSweepCandidates(1_000_000)).find((c) => c.paymentId === payment.id);

  const first = await db.planSweep(await find(), MERCHANT_WALLET);
  await db.recordFailure(first.id, 'node timed out');

  const retry = await find();
  assert.ok(retry, 'payment did not come back after its sweep failed');
  assert.ok(await db.planSweep(retry, MERCHANT_WALLET), 'a second sweep could not be planned');
});

// --- the hot wallet's books ----------------------------------------------------

const internal = (from, to, amount, extra = {}) => ({
  txHash: extra.txHash ?? hash(),
  logIndex: 0,
  blockNumber: 1000,
  blockTime: new Date(),
  asset: extra.asset ?? 'USDT',
  from,
  to,
  amountUnits: amount,
});

const walletBalance = async (code, asset = 'USDT') => {
  const { rows } = await db.getPool().query(
    `SELECT COALESCE(SUM(balance_units), 0)::text AS b FROM ledger_balances
      WHERE code = $1 AND asset = $2 AND project_id IS NULL`,
    [code, asset],
  );
  return BigInt(rows[0].b);
};

test('a refill from the treasury is booked into the hot wallet', async () => {
  const hotBefore = await walletBalance('chain.hot_wallet');
  const treasuryBefore = await walletBalance('chain.treasury');

  const direction = await db.recordInternalTransfer(
    internal(WALLETS.treasury, WALLETS.hotWallet, usdt('5000.00')), WALLETS);

  assert.equal(direction, 'refill');
  assert.equal((await walletBalance('chain.hot_wallet')) - hotBefore, usdt('5000.00'));
  assert.equal(treasuryBefore - (await walletBalance('chain.treasury')), usdt('5000.00'));
});

test('excess float returned to the treasury is booked the other way', async () => {
  const direction = await db.recordInternalTransfer(
    internal(WALLETS.hotWallet, WALLETS.treasury, usdt('1200.00')), WALLETS);
  assert.equal(direction, 'return');
});

test('the same refill read twice is booked once', async () => {
  const transfer = internal(WALLETS.treasury, WALLETS.hotWallet, usdt('333.00'));
  const before = await walletBalance('chain.hot_wallet');

  assert.equal(await db.recordInternalTransfer(transfer, WALLETS), 'refill');
  assert.equal(await db.recordInternalTransfer(transfer, WALLETS), null);

  assert.equal((await walletBalance('chain.hot_wallet')) - before, usdt('333.00'));
});

test('TRX refills are booked too, so paid fees do not drive the hot wallet negative', async () => {
  const before = await walletBalance('chain.hot_wallet', 'TRX');
  await db.recordInternalTransfer(
    internal(WALLETS.treasury, WALLETS.hotWallet, 150_000000n, { asset: 'TRX' }), WALLETS);
  assert.equal((await walletBalance('chain.hot_wallet', 'TRX')) - before, 150_000000n);
});

test('money reaching the hot wallet from anywhere else is not put on our books', async () => {
  // It might be ours, or a stranger's mistake. Guessing either way wrongly
  // puts somebody else's money in our accounts.
  const before = await walletBalance('chain.hot_wallet');
  const stranger = 'TYZGhS8UG5okCZneaJoYZJJhsqeD6ZZZZZ';

  assert.equal(await db.recordInternalTransfer(internal(stranger, WALLETS.hotWallet, usdt('10.00')), WALLETS), null);
  assert.equal(await walletBalance('chain.hot_wallet'), before);
});

test('after all of it the books still balance in both assets', async () => {
  const { rows } = await db.getPool().query(
    `SELECT asset, SUM(balance_units)::text AS total FROM ledger_balances GROUP BY asset`,
  );
  for (const row of rows) assert.equal(row.total, '0', `${row.asset} does not balance`);
});
