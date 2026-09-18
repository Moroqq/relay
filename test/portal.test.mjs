/**
 * The merchant side, end to end: an application from the website, approval in
 * the console, the invitation, sign-in, and what a merchant can then do — and
 * the ways in that must stay shut, because this server faces the internet.
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
const { buildConsoleServer, CSRF_HEADER: CONSOLE_CSRF } = await import('../services/console/dist/server.js');
const { buildPortalServer, CSRF_HEADER, defaultLimits } = await import('../services/portal/dist/server.js');
const { RateLimit } = await import('../services/portal/dist/limits.js');

const CONSOLE_KEY = auth.parseSecretboxKey(auth.newSecretboxKey());
const PORTAL_KEY = auth.parseSecretboxKey(auth.newSecretboxKey());
const CONSOLE_ORIGIN = 'http://127.0.0.1:3100';
const SITE_ORIGIN = 'http://127.0.0.1:5174';
const PORTAL_URL = 'http://127.0.0.1:5174/app/';

let consoleApp;
let portal;
let operatorCookie;

const portalConfig = {
  port: 3200, host: '127.0.0.1', secretKey: PORTAL_KEY, secureCookies: false,
  allowedOrigins: [SITE_ORIGIN], network: 'nile', liveKeys: false, webDir: null,
};

before(async () => {
  consoleApp = buildConsoleServer({
    port: 3100, host: '127.0.0.1', secretKey: CONSOLE_KEY, secureCookies: false, allowedOrigin: CONSOLE_ORIGIN,
    network: 'nile', webDir: null, portalUrl: PORTAL_URL, requireCode: true,
  });
  // Generous limits for the suite; the rate-limit test builds its own server.
  portal = buildPortalServer(portalConfig, {
    limits: { applications: new RateLimit(1000, 60_000), logins: new RateLimit(1000, 60_000), invites: new RateLimit(1000, 60_000) },
  });

  const password = auth.generatePassword();
  const secret = auth.newTotpSecret();
  const operator = await db.createOperator({
    email: 'req-op-' + randomBytes(5).toString('hex') + '@relay.test', name: 'Requests Op', role: 'operator',
    passwordHash: await auth.hashPassword(password), totpSecretSealed: auth.seal(secret, CONSOLE_KEY),
  });
  const res = await consoleApp.inject({
    method: 'POST', url: '/admin/api/login',
    payload: { email: operator.email, password, code: auth.totp(auth.decodeTotpSecret(secret), Math.floor(Date.now() / 1000)) },
    headers: { [CONSOLE_CSRF]: '1', origin: CONSOLE_ORIGIN },
  });
  assert.equal(res.statusCode, 200, res.body);
  operatorCookie = res.headers['set-cookie'].split(';')[0];
});

after(async () => { await consoleApp?.close(); await portal?.close(); await db.closePool(); });

const send = (app, method, url, payload, headers = {}) =>
  app.inject({ method, url, payload, headers: { [CSRF_HEADER]: '1', origin: SITE_ORIGIN, ...headers } });
const portalPost = (url, payload, cookie) => send(portal, 'POST', url, payload, cookie ? { cookie } : {});
const portalGet = (url, cookie) => portal.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });
const consolePost = (url, payload) =>
  consoleApp.inject({ method: 'POST', url, payload, headers: { [CONSOLE_CSRF]: '1', origin: CONSOLE_ORIGIN, cookie: operatorCookie } });

const application = (over = {}) => ({
  company: 'Forum ' + randomBytes(3).toString('hex'),
  website: 'forum.example',
  contact_name: 'Ada Example',
  email: 'ada-' + randomBytes(5).toString('hex') + '@forum.test',
  telegram: '@ada_example',
  monthly_volume: '10k_100k',
  use_case: 'Balance top-ups for our forum members in USDT.',
  ...over,
});

async function apply(over) {
  const body = application(over);
  const res = await portalPost('/portal/api/access-requests', body);
  assert.equal(res.statusCode, 201, res.body);
  const found = (await db.listAccessRequests({ status: 'new', limit: 500 })).find((r) => r.email === body.email);
  assert.ok(found, 'application was not stored');
  return found;
}

async function approve(requestId, body = { fee_percent: 1.5 }) {
  const res = await consolePost('/admin/api/requests/' + requestId + '/approve', body);
  assert.equal(res.statusCode, 200, res.body);
  const { invite_url } = res.json();
  assert.ok(invite_url.startsWith(PORTAL_URL + '#/invite/'));
  return invite_url.split('#/invite/')[1];
}

const code = (secret, offsetSeconds = 0) => auth.totp(auth.decodeTotpSecret(secret), Math.floor(Date.now() / 1000) + offsetSeconds);

/** Apply, approve, accept the invitation: a signed-in merchant, and what it took. */
async function merchant() {
  const request = await apply();
  const token = await approve(request.id);
  const started = (await portalPost('/portal/api/invite/start', { token })).json();
  const password = 'correct horse battery staple';
  const res = await portalPost('/portal/api/invite/complete', { token, password, code: code(started.secret) });
  assert.equal(res.statusCode, 200, res.body);
  return { request, token, secret: started.secret, password, cookie: res.headers['set-cookie'].split(';')[0], me: res.json() };
}

test('an application from the website is stored for review', async () => {
  const request = await apply({ telegram: '@someone_here' });
  assert.equal(request.status, 'new');
  assert.equal(request.telegram, 'someone_here');
});

test('an application with a bad field is refused, and says which field', async () => {
  const res = await portalPost('/portal/api/access-requests', application({ email: 'not-an-email' }));
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'invalid_email');
});

test('a bot that fills the hidden field is thanked and ignored', async () => {
  const body = application({ fax: 'buy now' });
  const res = await portalPost('/portal/api/access-requests', body);
  assert.equal(res.statusCode, 201);
  const all = await db.listAccessRequests({ status: 'all', limit: 500 });
  assert.equal(all.some((r) => r.email === body.email), false);
});

test('the application form is rate limited per address', async () => {
  const strict = buildPortalServer(portalConfig, { limits: { ...defaultLimits(), applications: new RateLimit(2, 60_000) } });
  try {
    const codes = [];
    for (let i = 0; i < 3; i++) {
      const res = await send(strict, 'POST', '/portal/api/access-requests', application());
      codes.push(res.statusCode);
    }
    assert.deepEqual(codes, [201, 201, 429]);
  } finally {
    await strict.close();
  }
});

test('changes without the portal header, or from another site, are refused', async () => {
  const noHeader = await portal.inject({ method: 'POST', url: '/portal/api/access-requests', payload: application(), headers: { origin: SITE_ORIGIN } });
  assert.equal(noHeader.statusCode, 403);
  const elsewhere = await send(portal, 'POST', '/portal/api/access-requests', application(), { origin: 'https://evil.example' });
  assert.equal(elsewhere.statusCode, 403);
});

test('approving creates the merchant, a project and an invited account; approving twice does not', async () => {
  const request = await apply();
  await approve(request.id, { fee_percent: 2, project_name: 'Main forum' });
  const after = await db.findAccessRequest(request.id);
  assert.equal(after.status, 'approved');
  assert.equal(after.accountStatus, 'invited');
  const projects = await db.listMerchantProjects(after.merchantId);
  assert.equal(projects.length, 1);
  assert.equal(projects[0].name, 'Main forum');
  assert.equal(projects[0].feeRateBps, 200n);

  const again = await consolePost('/admin/api/requests/' + request.id + '/approve', { fee_percent: 1 });
  assert.equal(again.statusCode, 409);
});

test('a second application from an email that already has an account cannot be approved', async () => {
  const first = await apply();
  await approve(first.id);
  const second = await apply({ email: first.email.toUpperCase() });
  const res = await consolePost('/admin/api/requests/' + second.id + '/approve', { fee_percent: 1 });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error.code, 'email_taken');
});

test('a rejection needs a note and closes the application', async () => {
  const request = await apply();
  assert.equal((await consolePost('/admin/api/requests/' + request.id + '/reject', { note: ' ' })).statusCode, 400);
  const res = await consolePost('/admin/api/requests/' + request.id + '/reject', { note: 'not a fit for now' });
  assert.equal(res.statusCode, 200);
  assert.equal((await db.findAccessRequest(request.id)).status, 'rejected');
});

test('an invitation needs a code from the new app and a long enough password, and works once', async () => {
  const request = await apply();
  const token = await approve(request.id);
  assert.equal((await portalPost('/portal/api/invite/inspect', { token })).json().email, request.email);

  const { secret } = (await portalPost('/portal/api/invite/start', { token })).json();
  const weak = await portalPost('/portal/api/invite/complete', { token, password: 'short', code: code(secret) });
  assert.equal(weak.json().error.code, 'weak_password');
  const wrong = await portalPost('/portal/api/invite/complete', { token, password: 'a long enough password', code: '000000' });
  assert.equal(wrong.json().error.code, 'wrong_code');

  const ok = await portalPost('/portal/api/invite/complete', { token, password: 'a long enough password', code: code(secret) });
  assert.equal(ok.statusCode, 200);
  assert.match(ok.headers['set-cookie'], /relay_portal=.*HttpOnly.*SameSite=Strict/);

  const reused = await portalPost('/portal/api/invite/inspect', { token });
  assert.equal(reused.statusCode, 404);
});

test('a fresh invitation replaces the old link', async () => {
  const request = await apply();
  const first = await approve(request.id);
  const res = await consolePost('/admin/api/requests/' + request.id + '/reinvite', {});
  assert.equal(res.statusCode, 200);
  const second = res.json().invite_url.split('#/invite/')[1];
  assert.equal((await portalPost('/portal/api/invite/inspect', { token: first })).statusCode, 404);
  assert.equal((await portalPost('/portal/api/invite/inspect', { token: second })).statusCode, 200);
});

test('a merchant signs in with password and code; every wrong answer looks the same', async () => {
  const m = await merchant();
  const email = m.request.email;
  const bad = [
    { email, password: 'wrong password here', code: code(m.secret, 30) },
    { email: 'nobody-' + randomBytes(3).toString('hex') + '@x.test', password: m.password, code: code(m.secret, 30) },
    { email, password: m.password, code: '000000' },
  ];
  const bodies = [];
  for (const b of bad) {
    const res = await portalPost('/portal/api/login', b);
    assert.equal(res.statusCode, 401);
    bodies.push(res.body);
  }
  assert.equal(new Set(bodies).size, 1);

  // The code the invitation used is spent; the next one works.
  const res = await portalPost('/portal/api/login', { email, password: m.password, code: code(m.secret, 30) });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().merchant.name, m.request.company);
});

test('a merchant sees only their own project', async () => {
  const a = await merchant();
  const b = await merchant();
  const mine = (await portalGet('/portal/api/projects', a.cookie)).json().data;
  assert.equal(mine.length, 1);
  assert.equal(mine[0].balance.usdt.available, '0.000000');

  const theirs = (await portalGet('/portal/api/projects', b.cookie)).json().data[0].id;
  for (const url of ['/deposits', '/payouts', '/keys']) {
    assert.equal((await portalGet('/portal/api/projects/' + theirs + url, a.cookie)).statusCode, 404);
  }
  assert.equal((await portalPost('/portal/api/projects/' + theirs + '/keys', { label: 'x' }, a.cookie)).statusCode, 404);
});

test('an API key is shown once, works against the API, and stops working when revoked', async () => {
  const m = await merchant();
  const projectId = (await portalGet('/portal/api/projects', m.cookie)).json().data[0].id;
  const created = await portalPost('/portal/api/projects/' + projectId + '/keys', { label: 'server' }, m.cookie);
  assert.equal(created.statusCode, 201);
  const { id, secret } = created.json();
  assert.match(secret, /^ak_test_/);
  assert.equal((await db.findProjectByApiKey(secret))?.id, projectId);

  const listed = (await portalGet('/portal/api/projects/' + projectId + '/keys', m.cookie)).json().data;
  assert.equal(listed.some((k) => 'secret' in k), false);

  assert.equal((await portalPost('/portal/api/projects/' + projectId + '/keys/' + id + '/revoke', {}, m.cookie)).statusCode, 200);
  assert.equal(await db.findProjectByApiKey(secret), null);
});

test('a payout request checks the address and the balance', async () => {
  const m = await merchant();
  const projectId = (await portalGet('/portal/api/projects', m.cookie)).json().data[0].id;
  const badAddress = await portalPost('/portal/api/projects/' + projectId + '/payouts', { amount: '10', to_address: 'TNotAnAddress' }, m.cookie);
  assert.equal(badAddress.json().error.code, 'invalid_address');
  const broke = await portalPost('/portal/api/projects/' + projectId + '/payouts',
    { amount: '10', to_address: 'TKxUU8588Zdt44Ues3p62gULLXtgTJ2CGb' }, m.cookie);
  assert.equal(broke.statusCode, 409);
  assert.equal(broke.json().error.code, 'insufficient_balance');
});

test('webhook settings: a real address only, and a new secret shown once', async () => {
  const m = await merchant();
  const projectId = (await portalGet('/portal/api/projects', m.cookie)).json().data[0].id;
  const put = (url) => send(portal, 'PUT', '/portal/api/projects/' + projectId + '/webhook', { url }, { cookie: m.cookie });
  assert.equal((await put('ftp://nope.example')).statusCode, 400);
  assert.equal((await put('https://forum.example/relay/hook')).statusCode, 200);
  const rotated = await portalPost('/portal/api/projects/' + projectId + '/webhook/secret', {}, m.cookie);
  assert.match(rotated.json().secret, /^whsec_/);
  const project = await db.findProject(projectId);
  assert.equal(project.webhookSecret, rotated.json().secret);
  assert.equal(project.webhookUrl, 'https://forum.example/relay/hook');
});

test('after signing out the old cookie is dead, and nothing is readable without one', async () => {
  const m = await merchant();
  assert.equal((await portalGet('/portal/api/me', m.cookie)).statusCode, 200);
  assert.equal((await portalPost('/portal/api/logout', {}, m.cookie)).statusCode, 200);
  assert.equal((await portalGet('/portal/api/me', m.cookie)).statusCode, 401);
  assert.equal((await portalGet('/portal/api/projects')).statusCode, 401);
});

test('what a merchant does is in the audit log under their name', async () => {
  const m = await merchant();
  const projectId = (await portalGet('/portal/api/projects', m.cookie)).json().data[0].id;
  await portalPost('/portal/api/projects/' + projectId + '/keys', { label: 'audit me' }, m.cookie);
  const { rows } = await db.getPool().query(
    `SELECT action FROM audit_log WHERE merchant_user_id = $1 ORDER BY id`, [m.me.user.id]);
  const actions = rows.map((r) => r.action);
  assert.ok(actions.includes('merchant.invite_accepted'));
  assert.ok(actions.includes('api_key.created'));
});
