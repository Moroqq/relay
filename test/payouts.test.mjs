/**
 * Paying merchants out of the treasury.
 *
 * The only operation that sends money to an address we do not own, and the
 * only one with no undo. These tests are mostly about what must never happen.
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
  readMerchantBalance, requestPayout, approvePayout, rejectPayout,
  findSendablePayouts, recordPayoutSigned, recordPayoutCompleted,
  PayoutError,
} = await import('@relay/db');
const { DepositWallet } = await import('@relay/wallet');

const wallet = DepositWallet.fromMnemonic(process.env.WALLET_MNEMONIC);
const usdt = (t) => parseAmount(t, 'USDT');
const MERCHANT_WALLET = 'TKxUU8588Zdt44Ues3p62gULLXtgTJ2CGb';
const hash = () => randomBytes(32).toString('hex');

let merchantId;
let projectId;

before(async () => {
  merchantId = newId('merchant');
  projectId = newId('project');
  await inTransaction(async (client) => {
    await client.query('INSERT INTO merchants (id, name) VALUES ($1, $2)', [merchantId, 'Payout Co']);
    await client.query(
      `INSERT INTO projects (id, merchant_id, name, fee_rate_bps) VALUES ($1, $2, 'Payouts', 100)`,
      [projectId, merchantId],
    );
  });
});

// The ledger is append-only by design, so nothing is deleted here.
after(async () => { await closePool(); });

/** Credit `amount` to the merchant by putting a deposit through. */
async function credit(amount) {
  const { user } = await ensureEndUser(
    projectId, `p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, wallet,
  );
  const d = await recordDeposit(
    { toAddress: user.depositAddress, asset: 'USDT', amountUnits: usdt(amount),
      txHash: hash(), logIndex: 0, blockNumber: 500 },
    20,
  );
  await creditDeposit(d.id, 20);
}

const balance = () => readMerchantBalance(projectId, 'USDT');

const ask = (amount, extra = {}) =>
  requestPayout({
    projectId,
    externalRef: extra.ref ?? null,
    asset: 'USDT',
    amountUnits: usdt(amount),
    toAddress: MERCHANT_WALLET,
  });

/** The hot wallet payouts leave from. Any valid address will do for the books. */
const HOT_WALLET = 'TPNnoowojVHucZZrKii9fox3Zq2MGLdXkp';

const complete = async (payout, feeSun = 0n) => {
  const tx = hash();
  const claimed = await recordPayoutSigned(payout.id, tx, { txID: tx }, HOT_WALLET);
  assert.equal(claimed, true, 'payout could not be claimed for signing');
  return recordPayoutCompleted(payout.id, feeSun);
};

const entriesFor = async (payoutId) => {
  const { rows } = await getPool().query(
    `SELECT a.code, a.asset, e.amount_units
       FROM ledger_entries e
       JOIN ledger_accounts a ON a.id = e.account_id
       JOIN ledger_transactions t ON t.id = e.transaction_id
      WHERE t.payout_id = $1 AND t.kind = 'payout.paid'
      ORDER BY a.code`,
    [payoutId],
  );
  return rows.map((r) => ({ code: r.code, amount: BigInt(r.amount_units) }));
};

test('a credited deposit becomes a withdrawable balance, net of our cut', async () => {
  const before = await balance();
  await credit('1000.00');
  const after = await balance();

  // 1000 arrived, we kept 1%.
  assert.equal(after.owedUnits - before.owedUnits, usdt('990.00'));
  assert.equal(after.availableUnits - before.availableUnits, usdt('990.00'));
});

test('a payout cannot exceed what we owe', async () => {
  const available = (await balance()).availableUnits;
  await assert.rejects(
    ask((Number(available) / 1e6 + 1).toFixed(2)),
    (e) => e instanceof PayoutError && e.code === 'insufficient_balance',
  );
});

test('a requested payout reserves its amount', async () => {
  await credit('500.00');
  const before = await balance();

  const { payout } = await ask('100.00');

  const after = await balance();
  assert.equal(after.owedUnits, before.owedUnits, 'the debt itself has not changed');
  assert.equal(after.reservedUnits - before.reservedUnits, usdt('100.00'));
  assert.equal(before.availableUnits - after.availableUnits, usdt('100.00'));
  assert.equal(payout.state, 'requested');
});

test('two simultaneous requests cannot both spend the same balance', async () => {
  // Without a lock both would read the same available figure and both would
  // pass a check only one of them should.
  await credit('200.00');
  const available = (await balance()).availableUnits;
  const each = (available / 1_000000n) * 1_000000n; // the whole lot, twice

  const results = await Promise.allSettled([
    ask((Number(each) / 1e6).toFixed(2)),
    ask((Number(each) / 1e6).toFixed(2)),
  ]);

  const accepted = results.filter((r) => r.status === 'fulfilled');
  assert.equal(accepted.length, 1, 'both requests were accepted');
  assert.ok((await balance()).availableUnits >= 0n);
});

test('rejecting a payout gives the balance back', async () => {
  await credit('300.00');
  const before = await balance();

  const { payout } = await ask('250.00');
  assert.equal(before.availableUnits - (await balance()).availableUnits, usdt('250.00'));

  await rejectPayout(payout.id, 'sanctions check failed');
  assert.equal((await balance()).availableUnits, before.availableUnits);
});

test('a rejected payout cannot then be approved', async () => {
  await credit('100.00');
  const { payout } = await ask('50.00');
  await rejectPayout(payout.id, 'no');

  assert.equal(await approvePayout(payout.id, 'operator'), null);
});

test('a retried request returns the original, not a second payment', async () => {
  await credit('400.00');
  const ref = `w-${Date.now()}`;

  const first = await ask('120.00', { ref });
  const second = await ask('120.00', { ref });

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.payout.id, second.payout.id);
  // And only one reservation was made.
  assert.equal((await balance()).reservedUnits >= usdt('120.00'), true);
});

test('small payouts can clear automatically, large ones cannot', async () => {
  await getPool().query(
    'UPDATE projects SET payout_auto_approve_units = $2 WHERE id = $1',
    [projectId, usdt('100.00').toString()],
  );
  await credit('1000.00');

  const small = await ask('50.00');
  const large = await ask('500.00');

  assert.equal(small.payout.state, 'approved');
  assert.equal(small.payout.approvedBy, 'auto');
  assert.equal(large.payout.state, 'requested');

  await getPool().query('UPDATE projects SET payout_auto_approve_units = 0 WHERE id = $1', [projectId]);
  await rejectPayout(large.payout.id, 'tidying up');
});

test('a zero threshold means every payout waits for a person', async () => {
  // The right default for a young platform: nothing leaves unattended.
  await credit('100.00');
  const { payout } = await ask('10.00');
  assert.equal(payout.state, 'requested');

  const approved = await approvePayout(payout.id, 'm.kern');
  assert.equal(approved.state, 'approved');
  assert.equal(approved.approvedBy, 'm.kern');
});

test('an approved payout appears in the send queue', async () => {
  await credit('100.00');
  const { payout } = await ask('30.00');
  await approvePayout(payout.id, 'operator');

  const queue = await findSendablePayouts(500);
  assert.ok(queue.some((p) => p.id === payout.id));
});

test('completing a payout settles the debt and empties the hot wallet by the net', async () => {
  await credit('600.00');
  const before = await balance();
  const { payout } = await ask('400.00');
  await approvePayout(payout.id, 'operator');

  await complete(payout);

  const entries = await entriesFor(payout.id);
  // Ordered by account code, so the hot wallet comes first alphabetically.
  assert.deepEqual(entries, [
    // That much left the wallet that signed it — the hot wallet, not the
    // treasury, whose key is not on the server at all.
    { code: 'chain.hot_wallet', amount: -usdt('400.00') },
    // And the liability moves toward zero: we owe 400 less.
    { code: 'merchant.payable', amount: usdt('400.00') },
  ]);
  assert.equal(entries.reduce((s, e) => s + e.amount, 0n), 0n);

  const after = await balance();
  assert.equal(before.owedUnits - after.owedUnits, usdt('400.00'));
  // The reservation is gone too, because the payout is no longer in flight.
  assert.equal(after.reservedUnits, before.reservedUnits);
});

test('a withdrawal fee stays with us rather than leaving', async () => {
  await getPool().query(
    'UPDATE projects SET payout_fee_flat_units = $2 WHERE id = $1',
    [projectId, usdt('1.50').toString()],
  );
  await credit('300.00');

  const { payout } = await ask('200.00');
  assert.equal(payout.feeUnits, usdt('1.50'));
  assert.equal(payout.netUnits, usdt('198.50'));

  await approvePayout(payout.id, 'operator');
  await complete(payout);

  const entries = await entriesFor(payout.id);
  const byCode = Object.fromEntries(entries.map((e) => [e.code, e.amount]));
  // The merchant's balance drops by the full 200 they asked for...
  assert.equal(byCode['merchant.payable'], usdt('200.00'));
  // ...only 198.50 actually leaves...
  assert.equal(byCode['chain.hot_wallet'], -usdt('198.50'));
  // ...and the difference is ours.
  assert.equal(byCode['platform.fee_revenue'], -usdt('1.50'));
  assert.equal(entries.reduce((s, e) => s + e.amount, 0n), 0n);

  await getPool().query('UPDATE projects SET payout_fee_flat_units = 0 WHERE id = $1', [projectId]);
});

test('a payout cannot be completed twice', async () => {
  await credit('200.00');
  const { payout } = await ask('90.00');
  await approvePayout(payout.id, 'operator');

  const first = await complete(payout);
  const second = await recordPayoutCompleted(payout.id, 0n);
  const third = await recordPayoutCompleted(payout.id, 0n);

  assert.ok(first);
  assert.equal(second, null);
  assert.equal(third, null);
  assert.equal((await entriesFor(payout.id)).length, 2);
});

test('the network fee is booked against the hot wallet, in TRX', async () => {
  await credit('150.00');
  const { payout } = await ask('100.00');
  await approvePayout(payout.id, 'operator');
  await complete(payout, 163_020n);

  const { rows } = await getPool().query(
    `SELECT a.code, a.asset, e.amount_units
       FROM ledger_entries e
       JOIN ledger_accounts a ON a.id = e.account_id
       JOIN ledger_transactions t ON t.id = e.transaction_id
      WHERE t.payout_id = $1 AND t.kind = 'gas.spent' ORDER BY a.code`,
    [payout.id],
  );
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.asset === 'TRX'));
  assert.equal(rows.reduce((s, r) => s + BigInt(r.amount_units), 0n), 0n);
});

test('after all of this the books still balance', async () => {
  const { rows } = await getPool().query(
    `SELECT asset, SUM(balance_units)::text AS total FROM ledger_balances GROUP BY asset`,
  );
  for (const row of rows) {
    assert.equal(row.total, '0', `${row.asset} does not balance`);
  }
});
