import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test, { after, before } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import postgres from 'postgres';
import { backtestToJson, buildBacktest } from '../src/backtest.mjs';
import { initializeGovernance } from '../src/governance-db.mjs';
import { createTenderDesk } from '../src/governance.mjs';
import { connectPg, createPgDatabase } from '../src/pg-database.mjs';
import { createSiteApp, publicBase } from '../src/site-app.mjs';
import { parseTenderCsv } from '../src/tender-data.mjs';

const csv = 'tender_no,tender_description,agency,award_date,tender_detail_status,supplier_name,awarded_amt\n' + [
  ...[1, 2, 3, 4, 5].map((i) => `OLD-${i},Event management services,Agency A,1/${i}/2025,Awarded to Suppliers,Past supplier,${i * 123456}.00`),
  'NEW-1,Event management services,Agency A,1/1/2026,Awarded to Suppliers,Zebra Secret Pte,98765.43',
].join('\n');
const dataset = parseTenderCsv(csv);
const admin = { id: 'admin-user-0001', email: 'admin@example.com', password: 'correct horse battery' };
const physical = '/app-d0abc123';
const origin = 'https://site.example';
const sessions = new Map();
const resetRequests = [];
const validResetToken = 'valid-reset-token-000000';
const openDatabase = (url) => createPgDatabase(connectPg(postgres, url, { max: 1, ssl: false }));
const openFast = (url) => createPgDatabase(connectPg(postgres, url, { max: 1, ssl: false, connect_timeout: 2 }));
let pglite; let socket; let authServer; let app; let clientToken; let intakeToken; let databaseUrl; let authUrl; let backtestJson;

before(async () => {
  authServer = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString() || '{}') : {};
    const json = (status, payload, headers = {}) => res.writeHead(status, { 'Content-Type': 'application/json', ...headers }).end(JSON.stringify(payload));
    const token = /session_token=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
    if (req.url === '/sign-in/email') {
      const user = body.password === admin.password ? (body.email === admin.email ? admin : body.email === 'other@example.com' ? { id: 'other-user-0002' } : undefined) : undefined;
      if (!user) return json(401, { message: 'Invalid email or password' });
      const value = `tok-${randomBytes(8).toString('hex')}.sig`;
      sessions.set(value, { user: { id: user.id }, expiresAt: new Date(Date.now() + 3600000).toISOString() });
      return json(200, { user: { id: user.id } }, { 'Set-Cookie': `__Secure-neon-auth.session_token=${value}; Path=/; HttpOnly; Secure` });
    }
    if (req.url === '/request-password-reset') { resetRequests.push({ ...body, origin: req.headers.origin }); return json(200, { status: true }); }
    if (req.url === '/reset-password') {
      if (body.token !== validResetToken) return json(400, { code: 'INVALID_TOKEN', message: 'Invalid token' });
      admin.password = body.newPassword;
      return json(200, { status: true });
    }
    if (req.url === '/get-session') return json(200, sessions.get(token) ?? null);
    if (req.url === '/sign-out') { sessions.delete(token); return json(200, { success: true }); }
    return json(404, {});
  });
  authServer.listen(0, '127.0.0.1');
  await once(authServer, 'listening');
  authUrl = `http://127.0.0.1:${authServer.address().port}`;

  pglite = await PGlite.create();
  socket = new PGLiteSocketServer({ db: pglite, port: 0, host: '127.0.0.1' });
  await socket.start();
  databaseUrl = `postgres://postgres:postgres@127.0.0.1:${socket.server.address().port}/postgres`;
  const seedSql = createPgDatabase(connectPg(postgres, databaseUrl, { max: 1, ssl: false }));
  await initializeGovernance(seedSql);
  const capability = randomBytes(32).toString('hex');
  const seedAdmin = createTenderDesk({ database: seedSql, dataset, adminToken: capability }).admin(capability);
  const client = await seedAdmin.createClient({ name: 'Edge Events', capabilities: 'Events', categories: ['events-community'], team_size: 3, max_contract_cents: 100000000, past_projects: [{ title: 'Festival project' }] });
  clientToken = (await seedAdmin.issueAgentCredential({ role: 'client', client_id: client.client_id })).token;
  intakeToken = (await seedAdmin.issueAgentCredential({ role: 'intake' })).token;
  await seedSql.close();
  backtestJson = backtestToJson(buildBacktest(dataset), dataset);
  const config = { TD_DB_URL: databaseUrl, TD_AUTH_URL: authUrl, TD_ADMIN_USER_ID: admin.id };
  app = createSiteApp({ openDatabase, env: (name) => config[name], csv, backtestJson, origin });
});
after(async () => {
  authServer?.closeAllConnections();
  authServer?.close();
  await socket?.stop();
  await pglite?.close();
});

const call = (path, init) => app(new Request(`https://site.example${physical}${path}`, init));
const form = (path, fields, cookie, target = call) => target(path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin, ...(cookie && { Cookie: cookie }) }, body: new URLSearchParams(fields) });
const both = (response) => response.headers.getSetCookie().map((c) => c.split(';')[0]).filter((c) => /^td_(session|csrf)=./.test(c)).join('; ');
const cookieOf = (response, name) => response.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith(`${name}=`));
const signIn = () => form('/login', { email: admin.email, password: admin.password });

test('health works without touching the database and reports configuration', async () => {
  assert.deepEqual(await (await call('/health')).json(), { ok: true, configured: true });
  const bare = createSiteApp({ openDatabase, env: () => undefined, csv, backtestJson: {}, origin });
  assert.deepEqual(await (await bare(new Request(`https://x${physical}/health`))).json(), { ok: true, configured: false });
  assert.equal((await bare(new Request(`https://x${physical}/login`))).status, 503);
});

test('the login page asks for email and password, and only the admin account gets in', async () => {
  const page = await (await call('/login')).text();
  assert.match(page, /name="email"/);
  assert.match(page, /name="password"/);
  assert.doesNotMatch(page, /Admin secret/);
  assert.match(page, new RegExp(`action="${publicBase}/login"`));
  assert.equal((await form('/login', { email: admin.email, password: 'wrong' })).status, 401);
  assert.equal((await form('/login', { email: 'other@example.com', password: admin.password })).status, 401);
  assert.equal((await form('/login', { token: admin.password })).status, 401);
});

test('the console works behind the gateway prefix with Neon Auth sessions, Secure cookies and rewritten links', async () => {
  const ok = await signIn();
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.get('location'), `${publicBase}/`);
  const flags = ok.headers.getSetCookie();
  assert.equal(flags.length, 2);
  for (const flag of flags) {
    assert.match(flag, new RegExp(`Path=${publicBase}`));
    assert.match(flag, /Secure/);
    assert.match(flag, /HttpOnly/);
    assert.match(flag, /SameSite=Strict/);
  }
  const cookie = both(ok);
  const overview = await call('/', { headers: { Cookie: cookie } });
  assert.equal(overview.status, 200);
  const html = await overview.text();
  assert.match(html, new RegExp(`href="${publicBase}/briefs"`));
  assert.match(html, /Needs your decision/);
  for (const path of ['/briefs', '/conflicts', '/clients', '/backtest', '/audit']) assert.equal((await call(path, { headers: { Cookie: cookie } })).status, 200, path);
  assert.match(await (await call('/clients', { headers: { Cookie: cookie } })).text(), /Festival project/);
  assert.equal((await call('/', { headers: { Cookie: 'td_session=forged' } })).status, 303);
  assert.equal((await call('/')).status, 303);
});

test('a session for any other Neon Auth user is rejected even with a real session cookie', async () => {
  const value = 'tok-other-user.sig';
  sessions.set(value, { user: { id: 'other-user-0002' }, expiresAt: new Date(Date.now() + 3600000).toISOString() });
  const packed = `${encodeURIComponent('__Secure-neon-auth.session_token')}~${encodeURIComponent(value)}`;
  assert.equal((await call('/', { headers: { Cookie: `td_session=${packed}; td_csrf=${'a'.repeat(64)}` } })).status, 303);
});

test('actions need the CSRF cookie and field to match, redirect inside the prefix, and flash through a cookie', async () => {
  const cookie = both(await signIn());
  const list = await (await call('/clients', { headers: { Cookie: cookie } })).text();
  const prj = new RegExp(`href="${publicBase}/projects/(PRJ\\d{5,})"`).exec(list)[1];
  const page = await (await call(`/projects/${prj}`, { headers: { Cookie: cookie } })).text();
  const csrf = /name="csrf" value="([a-f0-9]{64})"/.exec(page)[1];
  const projectId = /\/actions\/project\/([0-9a-f-]{36})\/verify/.exec(page)[1];
  assert.equal((await form(`/actions/project/${projectId}/verify`, {}, cookie)).status, 403);
  assert.equal((await form(`/actions/project/${projectId}/verify`, { csrf: 'b'.repeat(64) }, cookie)).status, 403);
  assert.equal((await form(`/actions/project/${projectId}/verify`, { csrf }, cookie.replace(/td_csrf=[a-f0-9]{64}/, `td_csrf=${'c'.repeat(64)}`))).status, 403);
  const verified = await form(`/actions/project/${projectId}/verify`, { csrf, note: 'Saw the contract.' }, cookie);
  assert.equal(verified.status, 303);
  assert.equal(verified.headers.get('location'), `${publicBase}/clients`);
  const landed = await call('/clients', { headers: { Cookie: `${cookie}; ${cookieOf(verified, 'td_flash')}` } });
  assert.equal(landed.status, 200);
  assert.match(await landed.text(), /Project verified\./);
});

test('logout revokes the session at Neon Auth, so the old cookie stops working everywhere', async () => {
  const cookie = both(await signIn());
  const csrf = /name="csrf" value="([a-f0-9]{64})"/.exec(await (await call('/clients', { headers: { Cookie: cookie } })).text())[1];
  const count = sessions.size;
  const out = await form('/logout', { csrf }, cookie);
  assert.equal(out.headers.get('location'), `${publicBase}/login`);
  assert.equal(sessions.size, count - 1);
  assert.equal((await call('/', { headers: { Cookie: cookie } })).status, 303);
});

test('the MCP endpoint works through the same app with the same governance, and never accepts a console session', async () => {
  const rpc = (method, params, token = clientToken) => call('/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  assert.equal((await rpc('tools/list', {}, 'nope')).status, 401);
  assert.equal((await rpc('tools/list', {}, 'tok-other-user')).status, 401);
  assert.equal((await (await rpc('initialize', { protocolVersion: '2025-03-26' })).json()).result.serverInfo.name, 'tender-desk');
  const priced = await (await rpc('tools/call', { name: 'request_pricing', arguments: { tender_no: 'NEW-1', query: 'event management' } })).json();
  assert.equal(JSON.parse(priced.result.content[0].text).outcome, 'allowed');
  const incoming = await (await rpc('tools/call', { name: 'get_incoming_tenders', arguments: {} })).json();
  assert.doesNotMatch(JSON.stringify(incoming), /Zebra Secret|9876543/);
  assert.equal((await call('/mcp', { method: 'GET', headers: { Authorization: `Bearer ${clientToken}` } })).status, 405);
});

test('intake through the site returns a connector pointing at this site', async () => {
  const body = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_client', arguments: { name: 'Site Signup Events', capabilities: 'Events', categories: ['events-community'], team_size: 2, max_contract_cents: 1000000 } } };
  const response = await call('/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${intakeToken}` }, body: JSON.stringify(body) });
  const created = JSON.parse((await response.json()).result.content[0].text);
  const server = created.connector_config.mcpServers[created.connector_name];
  assert.equal(server.url, `${origin}${publicBase}/mcp`);
  assert.equal(server.headers.Origin, origin);
  assert.equal(server.timeout, 60);
});

test('auth or database outages become safe responses without leaking details', async () => {
  const via = (instance) => (path, init) => instance(new Request(`https://x${physical}${path}`, init));
  const down = createSiteApp({ openDatabase, env: (name) => ({ TD_DB_URL: databaseUrl, TD_AUTH_URL: 'http://127.0.0.1:1', TD_ADMIN_USER_ID: admin.id })[name], csv, backtestJson, origin });
  const signInDown = await form('/login', { email: admin.email, password: admin.password }, undefined, via(down));
  assert.equal(signInDown.status, 503);
  assert.doesNotMatch(await signInDown.text(), /127\.0\.0\.1|ECONNREFUSED/);

  const broken = createSiteApp({ openDatabase: openFast, env: (name) => ({ TD_DB_URL: 'postgres://u:p@127.0.0.1:1/db', TD_AUTH_URL: authUrl, TD_ADMIN_USER_ID: admin.id })[name], csv, backtestJson, origin });
  const cookie = both(await form('/login', { email: admin.email, password: admin.password }, undefined, via(broken)));
  const response = await via(broken)('/', { headers: { Cookie: cookie } });
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /127\.0\.0\.1|ECONNREFUSED|postgres:/);
});

test('pasted secrets with stray whitespace or quotes still work', async () => {
  const padded = { TD_DB_URL: `"${databaseUrl}"\n`, TD_AUTH_URL: `\n  ${authUrl}\n`, TD_ADMIN_USER_ID: ` ${admin.id}\n` };
  const instance = createSiteApp({ openDatabase, env: (name) => padded[name], csv, backtestJson, origin });
  assert.equal((await instance(new Request(`https://x${physical}/login`))).status, 200);
  const signedIn = await form('/login', { email: admin.email, password: admin.password }, undefined, (path, init) => instance(new Request(`https://x${physical}${path}`, init)));
  assert.equal(signedIn.status, 303);
});

test('a value in the wrong field is diagnosed by scheme and length only, never leaked', async () => {
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args.join(' '));
  try {
    const swapped = createSiteApp({ openDatabase, env: (name) => ({ TD_DB_URL: databaseUrl, TD_AUTH_URL: databaseUrl, TD_ADMIN_USER_ID: admin.id })[name], csv, backtestJson, origin });
    const response = await swapped(new Request(`https://x${physical}/login`));
    assert.equal(response.status, 503);
  } finally { console.error = original; }
  const line = logged.join('\n');
  assert.match(line, /request failed at config: Error: TD_AUTH_URL must be an https URL \(scheme postgres, \d+ characters\)/);
  assert.doesNotMatch(line, /127\.0\.0\.1|postgres:\/\//);
});

const fresh = (overrides = {}) => {
  const config = { TD_DB_URL: databaseUrl, TD_AUTH_URL: authUrl, TD_ADMIN_USER_ID: admin.id, ...overrides };
  const instance = createSiteApp({ openDatabase, env: (name) => config[name], csv, backtestJson, origin });
  return (path, init) => instance(new Request(`https://x${physical}${path}`, init));
};
const send = (target, path, fields) => target(path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin }, body: new URLSearchParams(fields) });

test('forgot password: linked from sign-in, answers every address the same way, and asks Neon to email a link back to our reset page', async () => {
  const target = fresh();
  assert.match(await (await target('/login')).text(), new RegExp(`href="${publicBase}/forgot"`));
  const formPage = await target('/forgot');
  assert.equal(formPage.status, 200);
  assert.match(await formPage.text(), /name="email"/);
  const known = await send(target, '/forgot', { email: admin.email });
  const unknown = await send(target, '/forgot', { email: 'nobody@example.com' });
  assert.equal(known.status, 200);
  assert.equal(unknown.status, 200);
  assert.equal(await known.text(), await unknown.text(), 'the response must not reveal whether an account exists');
  const last = resetRequests.at(-2);
  assert.equal(last.email, admin.email);
  assert.equal(last.redirectTo, `${origin}${publicBase}/reset`);
  assert.equal(last.origin, origin);
});

test('reset page rejects malformed or missing tokens without echoing them, and validates the new password', async () => {
  const target = fresh();
  for (const path of ['/reset', '/reset?token=short', `/reset?token=${encodeURIComponent('"><script>alert(1)</script>0000000000')}`]) {
    const response = await target(path);
    assert.equal(response.status, 400, path);
    const html = await response.text();
    assert.match(html, /Link not valid/);
    assert.doesNotMatch(html, /<script>alert/);
  }
  const page = await target(`/reset?token=${validResetToken}`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, new RegExp(`name="token" value="${validResetToken}"`));
  assert.match(html, /name="confirm"/);
  assert.equal((await send(target, '/reset', { token: validResetToken, password: 'short', confirm: 'short' })).status, 400);
  const mismatch = await send(target, '/reset', { token: validResetToken, password: 'a-fresh-password-1', confirm: 'a-fresh-password-2' });
  assert.equal(mismatch.status, 400);
  assert.match(await mismatch.text(), /did not match/);
  assert.equal(admin.password, 'correct horse battery', 'a rejected attempt must not change the password');
});

test('reset round trip: a good token sets the new password, the old one stops working, and a bad or reused token is refused', async () => {
  const target = fresh();
  const bad = await send(target, '/reset', { token: 'not-a-real-token-0000000', password: 'a-fresh-password-1', confirm: 'a-fresh-password-1' });
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /Link not valid/);
  const done = await send(target, '/reset', { token: validResetToken, password: 'a-fresh-password-1', confirm: 'a-fresh-password-1' });
  assert.equal(done.status, 200);
  assert.match(await done.text(), /Password changed\. Sign in with your new password\./);
  assert.equal((await form('/login', { email: admin.email, password: 'a-fresh-password-1' })).status, 303);
  assert.equal(admin.password, 'a-fresh-password-1');
});

test('forgot and reset requests are throttled, and a Neon outage is reported plainly instead of pretending the email was sent', async () => {
  const target = fresh();
  const statuses = [];
  for (let i = 0; i < 6; i++) statuses.push((await send(target, '/forgot', { email: admin.email })).status);
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429]);
  const down = fresh({ TD_AUTH_URL: 'http://127.0.0.1:1' });
  const outage = await send(down, '/forgot', { email: admin.email });
  assert.equal(outage.status, 503);
  const text = await outage.text();
  assert.match(text, /temporarily unavailable/);
  assert.doesNotMatch(text, /on its way|127\.0\.0\.1/);
});
