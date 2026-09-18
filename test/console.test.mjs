/**
 * The operations console. Most of these tests are about the ways in that must
 * stay shut, because the console decides where money goes.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(root, '.env')); } catch {}

const auth = await import('@relay/auth');
const db = await import('@relay/db');
const { newId, parseAmount } = await import('@relay/core');
const { DepositWallet } = await import('@relay/wallet');
const { buildConsoleServer, CSRF_HEADER } = await import('../services/console/dist/server.js');

const SECRET_KEY = auth.parseSecretboxKey(auth.newSecretboxKey());
const ORIGIN = 'http://127.0.0.1:3100';
const wallet = DepositWallet.fromMnemonic(process.env.WALLET_MNEMONIC);
const usdt = (t) => parseAmount(t, 'USDT');

let app;
let projectId;

before(async () => {
  app = buildConsoleServer({
    port: 3100, host: '127.0.0.1', secretKey: SECRET_KEY, secureCookies: false, allowedOrigin: ORIGIN, network: 'nile', webDir: null, portalUrl: 'http://127.0.0.1:5174/app/',
  });
  const merchantId = newId('merchant');
  projectId = newId('project');
  await db.inTransaction(async (client) => {
    await client.query('INSERT INTO merchants (id, name) VALUES ($1, $2)', [merchantId, 'Console Merchant']);
    await client.query(
      `INSERT INTO projects (id, merchant_id, name, fee_rate_bps) VALUES ($1, $2, 'Console Project', 100)`,
      [projectId, merchantId],
    );
  });
});

// Operators, sessions and audit rows stay: the audit log is append-only by design.
after(async () => { await app?.close(); await db.closePool(); });

/** A fresh operator per test: a TOTP code works once, so sharing one would race. */
async function makeOperator(role = 'operator') {
  const password = auth.generatePassword();
  const secret = auth.newTotpSecret();
  const operator = await db.createOperator({
    email: 'op-' + randomBytes(5).toString('hex') + '@relay.test',
    name: 'Op ' + role,
    role,
    passwordHash: await auth.hashPassword(password),
    totpSecretSealed: auth.seal(secret, SECRET_KEY),
  });
  const code = () => auth.totp(auth.decodeTotpSecret(secret), Math.floor(Date.now() / 1000));
  return { operator, password, secret, code };
}

const post = (url, payload, headers = {}) =>
  app.inject({ method: 'POST', url, payload, headers: { [CSRF_HEADER]: '1', origin: ORIGIN, ...headers } });

const get = (url, cookie) => app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });

async function signIn(op) {
  const res = await post('/admin/api/login', { email: op.operator.email, password: op.password, code: op.code() });
  assert.equal(res.statusCode, 200, res.body);
  return res.headers['set-cookie'].split(';')[0];
}

async function requestedPayout(amount) {
  const { user } = await db.ensureEndUser(projectId, 'u-' + randomBytes(5).toString('hex'), wallet);
  const d = await db.recordDeposit(
    { toAddress: user.depositAddress, asset: 'USDT', amountUnits: usdt((Number(amount) * 1.2).toFixed(2)),
      txHash: randomBytes(32).toString('hex'), logIndex: 0, blockNumber: 1 },
    20,
  );
  await db.creditDeposit(d.id, 20);
  const { payout } = await db.requestPayout({
    projectId, externalRef: null, asset: 'USDT', amountUnits: usdt(amount), toAddress: 'TKxUU8588Zdt44Ues3p62gULLXtgTJ2CGb',
  });
  return payout;
}

test('a correct password and code sign in, with a locked-down cookie', async () => {
  const op = await makeOperator();
  const res = await post('/admin/api/login', { email: op.operator.email, password: op.password, code: op.code() });

  assert.equal(res.statusCode, 200);
  const cookie = res.headers['set-cookie'];
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.deepEqual(Object.keys(res.json().operator).sort(), ['email', 'id', 'name', 'role']);
});

test('every kind of wrong answer looks exactly the same', async () => {
  // Distinguishable failures tell a guesser which part they got right.
  const op = await makeOperator();
  const attempts = [
    { email: 'nobody-' + randomBytes(4).toString('hex') + '@relay.test', password: op.password, code: op.code() },
    { email: op.operator.email, password: 'wrong password entirely', code: op.code() },
    { email: op.operator.email, password: op.password, code: '000000' },
  ];
  const bodies = [];
  for (const attempt of attempts) {
    const res = await post('/admin/api/login', attempt);
    assert.equal(res.statusCode, 401);
    bodies.push(res.body);
  }
  assert.equal(new Set(bodies).size, 1);
});

test('the right password without the code is not enough', async () => {
  const op = await makeOperator();
  for (const code of ['', '12345', undefined]) {
    const res = await post('/admin/api/login', { email: op.operator.email, password: op.password, code });
    assert.equal(res.statusCode, 401);
  }
});

test('a code cannot be used to sign in twice', async () => {
  const op = await makeOperator();
  const code = op.code();
  assert.equal((await post('/admin/api/login', { email: op.operator.email, password: op.password, code })).statusCode, 200);
  assert.equal((await post('/admin/api/login', { email: op.operator.email, password: op.password, code })).statusCode, 401);
});

test('five failures lock the account, and the right answer then does not open it', async () => {
  const op = await makeOperator();
  for (let i = 0; i < 5; i++) {
    await post('/admin/api/login', { email: op.operator.email, password: 'not the password ' + i, code: '000000' });
  }
  const res = await post('/admin/api/login', { email: op.operator.email, password: op.password, code: op.code() });
  assert.equal(res.statusCode, 401, 'a locked account let a correct login through');
});

test('a request without the console header is refused, even with a valid session', async () => {
  // Another site can make a browser send a form, but it cannot add this
  // header without a preflight this server never answers.
  const cookie = await signIn(await makeOperator());
  const res = await app.inject({ method: 'POST', url: '/admin/api/logout', headers: { cookie, origin: ORIGIN } });
  assert.equal(res.statusCode, 403);
});

test('a request from another origin is refused', async () => {
  const cookie = await signIn(await makeOperator());
  const res = await post('/admin/api/logout', {}, { cookie, origin: 'https://evil.example' });
  assert.equal(res.statusCode, 403);
});

test('the console refuses to be framed by another page', async () => {
  const res = await get('/admin/api/me');
  assert.equal(res.headers['x-frame-options'], 'DENY');
  assert.ok(res.headers['content-security-policy'].includes('frame-ancestors'));
  assert.equal(res.headers['cache-control'], 'no-store');
});

test('without a session nothing is readable', async () => {
  for (const url of ['/admin/api/me', '/admin/api/summary', '/admin/api/payouts', '/admin/api/audit']) {
    assert.equal((await get(url)).statusCode, 401, url);
    assert.equal((await get(url, 'relay_console=' + 'A'.repeat(43))).statusCode, 401, url + ' forged');
  }
});

test('after signing out the old cookie is dead', async () => {
  const cookie = await signIn(await makeOperator());
  assert.equal((await get('/admin/api/me', cookie)).statusCode, 200);
  assert.equal((await post('/admin/api/logout', {}, { cookie })).statusCode, 200);
  assert.equal((await get('/admin/api/me', cookie)).statusCode, 401);
});

test('disabling an operator ends their open session at once', async () => {
  const op = await makeOperator();
  const cookie = await signIn(op);
  await db.getPool().query(`UPDATE operators SET status = 'disabled' WHERE id = $1`, [op.operator.id]);
  assert.equal((await get('/admin/api/me', cookie)).statusCode, 401);
});

test('nothing secret about an operator is ever sent to the browser', async () => {
  const cookie = await signIn(await makeOperator());
  const body = (await get('/admin/api/me', cookie)).body.toLowerCase();
  for (const leak of ['password', 'totp', 'scrypt', 'sealed']) {
    assert.equal(body.includes(leak), false, 'response mentions ' + leak);
  }
});

test('an operator approves a payout and the audit log records who', async () => {
  const op = await makeOperator('operator');
  const cookie = await signIn(op);
  const payout = await requestedPayout('50.00');

  const listed = (await get('/admin/api/payouts?tab=requested', cookie)).json().data;
  assert.ok(listed.some((p) => p.id === payout.id && p.merchant.name === 'Console Merchant'));

  const res = await post('/admin/api/payouts/' + payout.id + '/approve', {}, { cookie });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal((await db.findPayout(payout.id)).state, 'approved');

  const audit = (await get('/admin/api/audit?subject=' + payout.id, cookie)).json().data;
  assert.equal(audit[0].action, 'payout.approved');
  assert.equal(audit[0].operator, op.operator.name);

  const approvedTab = (await get('/admin/api/payouts?tab=approved', cookie)).json().data;
  assert.equal(approvedTab.find((p) => p.id === payout.id).approved_by, op.operator.name);
});

test('a payout cannot be approved twice, or approved after it was rejected', async () => {
  const cookie = await signIn(await makeOperator('admin'));
  const once = await requestedPayout('20.00');
  assert.equal((await post('/admin/api/payouts/' + once.id + '/approve', {}, { cookie })).statusCode, 200);
  assert.equal((await post('/admin/api/payouts/' + once.id + '/approve', {}, { cookie })).statusCode, 409);

  const refused = await requestedPayout('20.00');
  const r = await post('/admin/api/payouts/' + refused.id + '/reject', { reason: 'not verified' }, { cookie });
  assert.equal(r.statusCode, 200);
  assert.equal((await post('/admin/api/payouts/' + refused.id + '/approve', {}, { cookie })).statusCode, 409);
});

test('two operators deciding the same payout at once: exactly one wins', async () => {
  const a = await signIn(await makeOperator('operator'));
  const b = await signIn(await makeOperator('operator'));
  const payout = await requestedPayout('30.00');

  const [approve, reject] = await Promise.all([
    post('/admin/api/payouts/' + payout.id + '/approve', {}, { cookie: a }),
    post('/admin/api/payouts/' + payout.id + '/reject', { reason: 'second thoughts' }, { cookie: b }),
  ]);
  assert.deepEqual([approve.statusCode, reject.statusCode].sort(), [200, 409]);
});

test('a rejection needs a reason, and gives the merchant their balance back', async () => {
  const cookie = await signIn(await makeOperator('operator'));
  const payout = await requestedPayout('40.00');
  const blank = await post('/admin/api/payouts/' + payout.id + '/reject', { reason: '  ' }, { cookie });
  assert.equal(blank.statusCode, 400);

  const reservedBefore = (await db.readMerchantBalance(projectId)).reservedUnits;
  const ok = await post('/admin/api/payouts/' + payout.id + '/reject', { reason: 'address flagged' }, { cookie });
  assert.equal(ok.statusCode, 200);
  assert.equal(reservedBefore - (await db.readMerchantBalance(projectId)).reservedUnits, usdt('40.00'));
});

test('a viewer can look but cannot decide', async () => {
  const cookie = await signIn(await makeOperator('viewer'));
  const payout = await requestedPayout('10.00');
  assert.equal((await get('/admin/api/payouts?tab=requested', cookie)).statusCode, 200);
  assert.equal((await post('/admin/api/payouts/' + payout.id + '/approve', {}, { cookie })).statusCode, 403);
  assert.equal((await db.findPayout(payout.id)).state, 'requested');
});

test('the summary shows balances with their sign and flags a short hot wallet', async () => {
  const cookie = await signIn(await makeOperator('viewer'));
  const summary = (await get('/admin/api/summary', cookie)).json();
  assert.equal(typeof summary.counts.requested, 'number');
  assert.match(summary.hot_wallet.trx, /^-?[0-9]+[.][0-9]{6}$/);
  assert.equal(typeof summary.hot_wallet_short, 'boolean');
});

test('the audit log cannot be rewritten, even from the database', async () => {
  const pool = db.getPool();
  await assert.rejects(pool.query(`UPDATE audit_log SET action = 'x' WHERE id = (SELECT max(id) FROM audit_log)`), /append-only/);
  await assert.rejects(pool.query(`DELETE FROM audit_log WHERE id = (SELECT max(id) FROM audit_log)`), /append-only/);
});

test('the console pages load without a session, under a policy that runs only their own code', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-console-web-'));
  await fs.mkdir(path.join(dir, 'assets'));
  await fs.writeFile(path.join(dir, 'index.html'), '<!doctype html><div id="root"></div>');
  await fs.writeFile(path.join(dir, 'assets', 'index-abc123.js'), 'export {};');
  const web = buildConsoleServer({
    port: 3100, host: '127.0.0.1', secretKey: SECRET_KEY, secureCookies: false, allowedOrigin: ORIGIN, network: 'nile', webDir: dir, portalUrl: 'http://127.0.0.1:5174/app/',
  });
  try {
    const page = await web.inject({ method: 'GET', url: '/admin/' });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /id="root"/);
    assert.equal(page.headers['cache-control'], 'no-store');
    const csp = page.headers['content-security-policy'];
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);

    const asset = await web.inject({ method: 'GET', url: '/admin/assets/index-abc123.js' });
    assert.equal(asset.statusCode, 200);
    assert.match(asset.headers['cache-control'], /immutable/);

    assert.equal((await web.inject({ method: 'GET', url: '/' })).headers.location, '/admin/');
    // The API behind the pages is still shut without a session.
    assert.equal((await web.inject({ method: 'GET', url: '/admin/api/summary' })).statusCode, 401);
    assert.equal((await web.inject({ method: 'GET', url: '/admin/assets/missing.js' })).headers['cache-control'], 'no-store');
  } finally {
    await web.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('the summary says when signing is locked, and when the sweeper has gone quiet', async () => {
  const cookie = await signIn(await makeOperator('viewer'));
  await db.reportServiceStatus('sweeper', 'locked', { payouts: 'dry_run', sweeps: 'dry_run', poll_ms: 30000 });
  let sweeper = (await get('/admin/api/summary', cookie)).json().sweeper;
  assert.equal(sweeper.state, 'locked');
  assert.equal(sweeper.stale, false);
  assert.equal(sweeper.payouts, 'dry_run');

  // A report ten minutes old: whatever it last said, it is not running now.
  await db.getPool().query(`UPDATE service_status SET updated_at = now() - interval '10 minutes' WHERE service = 'sweeper'`);
  sweeper = (await get('/admin/api/summary', cookie)).json().sweeper;
  assert.equal(sweeper.stale, true);

  // `since` marks the change of state, not the latest report.
  await db.reportServiceStatus('sweeper', 'unlocked', { payouts: 'live', sweeps: 'dry_run', poll_ms: 30000 });
  const before = (await get('/admin/api/summary', cookie)).json().sweeper.since;
  await db.reportServiceStatus('sweeper', 'unlocked', { payouts: 'live', sweeps: 'dry_run', poll_ms: 30000 });
  sweeper = (await get('/admin/api/summary', cookie)).json().sweeper;
  assert.equal(sweeper.since, before);
  assert.equal(sweeper.payouts, 'live');
});
