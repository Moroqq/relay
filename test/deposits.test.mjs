/**
 * The account model: permanent addresses, and deposits discovered rather than
 * invoiced.
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
  ensureEndUser, findEndUserByAddress,
  recordDeposit, creditDeposit, findDeposit, listDeposits,
} = await import('@relay/db');
const { DepositWallet, isValidAddress } = await import('@relay/wallet');

const wallet = DepositWallet.fromMnemonic(process.env.WALLET_MNEMONIC);
const usdt = (text) => parseAmount(text, 'USDT');
const txHash = () => randomBytes(32).toString('hex');

let merchantId;
let projectId;

before(async () => {
  merchantId = newId('merchant');
  projectId = newId('project');
  await inTransaction(async (client) => {
    await client.query('INSERT INTO merchants (id, name) VALUES ($1, $2)', [merchantId, 'Balance Co']);
    await client.query(
      `INSERT INTO projects (id, merchant_id, name, fee_rate_bps, webhook_url)
       VALUES ($1, $2, 'Top-ups', 100, 'https://example.test/hook')`,
      [projectId, merchantId],
    );
  });
});

// The ledger is append-only by design, so nothing is deleted here.
after(async () => { await closePool(); });

const newRef = () => `u-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const deposit = (address, amount, extra = {}) =>
  recordDeposit(
    {
      toAddress: address,
      asset: 'USDT',
      amountUnits: usdt(amount),
      txHash: extra.txHash ?? txHash(),
      logIndex: extra.logIndex ?? 0,
      blockNumber: extra.blockNumber ?? 1000,
    },
    20,
  );

const ledgerFor = async (depositId) => {
  const { rows } = await getPool().query(
    `SELECT a.code, e.amount_units
       FROM ledger_entries e
       JOIN ledger_accounts a ON a.id = e.account_id
       JOIN ledger_transactions t ON t.id = e.transaction_id
      WHERE t.reference = (SELECT tx_hash FROM deposits WHERE id = $1)
        AND t.kind = 'deposit.credited'
      ORDER BY a.code`,
    [depositId],
  );
  return rows.map((r) => ({ code: r.code, amount: BigInt(r.amount_units) }));
};

test('a user is given a real TRON address on first sight', async () => {
  const { user, created } = await ensureEndUser(projectId, newRef(), wallet);

  assert.equal(created, true);
  assert.match(user.id, /^USR_/);
  assert.ok(isValidAddress(user.depositAddress));
  assert.equal(user.status, 'active');
});

test('asking again returns the same address, never a second one', async () => {
  // Users save addresses, print them into QR codes, set up recurring
  // transfers. A second address would send somebody's money nowhere.
  const ref = newRef();
  const first = await ensureEndUser(projectId, ref, wallet);
  const second = await ensureEndUser(projectId, ref, wallet);

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.user.id, second.user.id);
  assert.equal(first.user.depositAddress, second.user.depositAddress);
});

test('simultaneous first requests still yield one address', async () => {
  const ref = newRef();
  const results = await Promise.all(
    Array.from({ length: 8 }, () => ensureEndUser(projectId, ref, wallet)),
  );

  assert.equal(new Set(results.map((r) => r.user.depositAddress)).size, 1);
  assert.equal(results.filter((r) => r.created).length, 1);
});

test('different users get different addresses', async () => {
  const users = await Promise.all(
    Array.from({ length: 10 }, () => ensureEndUser(projectId, newRef(), wallet)),
  );
  assert.equal(new Set(users.map((u) => u.user.depositAddress)).size, 10);
});

test('an address resolves back to its owner', async () => {
  const { user } = await ensureEndUser(projectId, newRef(), wallet);
  const found = await findEndUserByAddress(user.depositAddress);
  assert.equal(found.id, user.id);
});

test('money arriving at a user address becomes a deposit', async () => {
  const { user } = await ensureEndUser(projectId, newRef(), wallet);
  const record = await deposit(user.depositAddress, '250.00');

  assert.ok(record);
  assert.match(record.id, /^DEP_/);
  assert.equal(record.endUserId, user.id);
  assert.equal(record.amountUnits, usdt('250.00'));
  assert.equal(record.state, 'detected');
  // Nothing was expected, so there is nothing to be short of.
  assert.equal(record.feeUnits, null);
});

test('money sent to an address we never issued is not ours to credit', async () => {
  const stranger = wallet.deriveAddress(999_999).address;
  assert.equal(await deposit(stranger, '100.00'), null);
});

test('the same transfer cannot be recorded twice', async () => {
  // The indexer re-reads blocks after every restart and every reorg. Without
  // this, each pass would credit the same money again.
  const { user } = await ensureEndUser(projectId, newRef(), wallet);
  const hash = txHash();

  const first = await deposit(user.depositAddress, '80.00', { txHash: hash, logIndex: 0 });
  const second = await deposit(user.depositAddress, '80.00', { txHash: hash, logIndex: 0 });

  assert.ok(first);
  assert.equal(second, null);
});

test('two transfers in one transaction are two deposits', async () => {
  // A batch payout carries several transfers under one hash. Keying on the
  // hash alone would lose all but the first.
  const { user } = await ensureEndUser(projectId, newRef(), wallet);
  const hash = txHash();

  const a = await deposit(user.depositAddress, '10.00', { txHash: hash, logIndex: 0 });
  const b = await deposit(user.depositAddress, '20.00', { txHash: hash, logIndex: 1 });

  assert.ok(a && b);
  assert.notEqual(a.id, b.id);
});

test('a user can top up again and again on the same address', async () => {
  // The difference from the invoice model in one test: there, an address
  // served one payment and was retired.
  const { user } = await ensureEndUser(projectId, newRef(), wallet);

  for (const amount of ['10.00', '25.50', '1000.00']) {
    assert.ok(await deposit(user.depositAddress, amount), `top-up of ${amount} was refused`);
  }

  const listed = await listDeposits(projectId, { endUserId: user.id });
  assert.equal(listed.length, 3);
});

test('a deposit is not credited before it is deep enough', async () => {
  const { user } = await ensureEndUser(projectId, newRef(), wallet);
  const record = await deposit(user.depositAddress, '480.00');

  const outcome = await creditDeposit(record.id, 5);

  assert.equal(outcome.deposit.state, 'confirming');
  assert.equal(outcome.deposit.feeUnits, null);
  assert.deepEqual(await ledgerFor(record.id), []);
});

test('a confirmed deposit is credited and split', async () => {
  const { user } = await ensureEndUser(projectId, newRef(), wallet);
  const record = await deposit(user.depositAddress, '480.00');

  const outcome = await creditDeposit(record.id, 20);

  assert.equal(outcome.deposit.state, 'credited');
  assert.equal(outcome.deposit.feeUnits, usdt('4.80'));
  assert.equal(outcome.deposit.netUnits, usdt('475.20'));
  assert.notEqual(outcome.deposit.creditedAt, null);
});

test('crediting writes three ledger entries that add to zero', async () => {
  const { user } = await ensureEndUser(projectId, newRef(), wallet);
  const record = await deposit(user.depositAddress, '480.00');
  await creditDeposit(record.id, 20);

  const entries = await ledgerFor(record.id);
  assert.deepEqual(entries, [
    { code: 'chain.deposits', amount: usdt('480.00') },
    { code: 'merchant.payable', amount: -usdt('475.20') },
    { code: 'platform.fee_revenue', amount: -usdt('4.80') },
  ]);
  assert.equal(entries.reduce((sum, e) => sum + e.amount, 0n), 0n);
});

test('the same deposit cannot be credited twice', async () => {
  const { user } = await ensureEndUser(projectId, newRef(), wallet);
  const record = await deposit(user.depositAddress, '150.00');

  const first = await creditDeposit(record.id, 20);
  const second = await creditDeposit(record.id, 20);
  const third = await creditDeposit(record.id, 25);

  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal(third.changed, false);
  assert.equal((await ledgerFor(record.id)).length, 3);
});

test('crediting queues exactly one webhook naming the merchant s own user id', async () => {
  const ref = newRef();
  const { user } = await ensureEndUser(projectId, ref, wallet);
  const record = await deposit(user.depositAddress, '120.00');

  await creditDeposit(record.id, 20);
  await creditDeposit(record.id, 20);

  const { rows } = await getPool().query(
    'SELECT event, payload, state FROM webhook_deliveries WHERE deposit_id = $1',
    [record.id],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event, 'deposit.credited');
  // The merchant credits their own user, so they must be told which one.
  assert.equal(rows[0].payload.data.user_ref, ref);
});

test('pricing is frozen at detection, not read at credit time', async () => {
  const { user } = await ensureEndUser(projectId, newRef(), wallet);
  const record = await deposit(user.depositAddress, '200.00');

  // The merchant's rate changes while the deposit is still confirming.
  await getPool().query('UPDATE projects SET fee_rate_bps = 900 WHERE id = $1', [projectId]);
  const outcome = await creditDeposit(record.id, 20);
  await getPool().query('UPDATE projects SET fee_rate_bps = 100 WHERE id = $1', [projectId]);

  // Charged at the 1% agreed when the money arrived, not the 9% set after.
  assert.equal(outcome.deposit.feeUnits, usdt('2.00'));
});

test('a deposit belongs to one user only, so attribution needs no amount tricks', async () => {
  // Two users deposit the identical amount at the same moment. On shared
  // addresses that would be ambiguous; on per-user addresses it is not.
  const a = await ensureEndUser(projectId, newRef(), wallet);
  const b = await ensureEndUser(projectId, newRef(), wallet);

  const da = await deposit(a.user.depositAddress, '99.99');
  const db = await deposit(b.user.depositAddress, '99.99');

  assert.equal(da.endUserId, a.user.id);
  assert.equal(db.endUserId, b.user.id);
  assert.notEqual(da.id, db.id);
});
