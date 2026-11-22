import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test, { after, before } from 'node:test';
import { createNeonAuth, signUpAdmin } from '../src/neon-auth.mjs';

const admin = { id: 'admin-user-0001', email: 'admin@example.com', password: 'correct horse battery' };
const sessions = new Map();
const seen = [];
let server; let base;

before(async () => {
  server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString() || '{}') : {};
    seen.push({ method: req.method, path: req.url, origin: req.headers.origin });
    const json = (status, payload, headers = {}) => res.writeHead(status, { 'Content-Type': 'application/json', ...headers }).end(JSON.stringify(payload));
    if (req.url === '/sign-in/email') {
      const user = body.email === admin.email && body.password === admin.password ? admin
        : body.email === 'other@example.com' ? { id: 'other-user-0002', email: 'other@example.com' } : undefined;
      if (!user) return json(401, { message: 'Invalid email or password' });
      const token = `tok-${user.id}.sig`;
      sessions.set(token, { user: { id: user.id }, expiresAt: new Date(Date.now() + 3600000).toISOString() });
      return json(200, { user: { id: user.id } }, { 'Set-Cookie': `__Secure-neon-auth.session_token=${token}; Path=/; HttpOnly; Secure; SameSite=None` });
    }
    if (req.url === '/get-session') {
      const token = /session_token=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
      return json(200, sessions.get(token) ?? null);
    }
    if (req.url === '/sign-out') {
      sessions.delete(/session_token=([^;]+)/.exec(req.headers.cookie ?? '')?.[1]);
      return json(200, { success: true });
    }
    if (req.url === '/request-password-reset') { seen.push({ method: req.method, path: req.url, origin: req.headers.origin, body }); return json(body.email === 'down@example.com' ? 503 : 200, { status: true }); }
    if (req.url === '/reset-password') {
      if (body.token === 'good-token-0000000000') return json(200, { status: true });
      if (body.token === 'weak-token-0000000000') return json(400, { code: 'PASSWORD_TOO_SHORT', message: 'Password too short' });
      if (body.token === 'boom-token-0000000000') return json(500, {});
      return json(400, { code: 'INVALID_TOKEN', message: 'Invalid token' });
    }
    if (req.url === '/sign-up/email') return json(200, { user: { id: 'new-user-0003', emailVerified: false } });
    return json(404, {});
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.closeAllConnections(); server.close(); });

const form = (fields) => new URLSearchParams(fields);
const make = () => createNeonAuth({ baseUrl: base, adminUserId: admin.id, origin: 'https://site.example' });

test('the admin signs in and the session is verified, then revoked on logout', async () => {
  const auth = make();
  const result = await auth.login(form({ email: admin.email, password: admin.password }));
  assert.ok(result.session);
  assert.equal(result.maxAge, 28800);
  assert.equal(await auth.verify(result.session), true);
  await auth.logout(result.session);
  assert.equal(await auth.verify(result.session), false);
  assert.ok(seen.every((call) => call.origin === 'https://site.example'));
});

test('a valid Neon Auth user who is not the admin is refused, so open sign-up grants nothing', async () => {
  const auth = make();
  assert.equal(await auth.login(form({ email: 'other@example.com', password: 'anything' })), undefined);
  sessions.set('tok-other', { user: { id: 'other-user-0002' }, expiresAt: new Date(Date.now() + 3600000).toISOString() });
  assert.equal(await auth.verify(`${encodeURIComponent('__Secure-neon-auth.session_token')}~tok-other`), false);
});

test('wrong passwords, empty input, forged or malformed sessions are all rejected', async () => {
  const auth = make();
  assert.equal(await auth.login(form({ email: admin.email, password: 'wrong' })), undefined);
  assert.equal(await auth.login(form({ email: '', password: '' })), undefined);
  for (const forged of ['', 'nope', 'a~b', '%E0%A4%A~x']) assert.equal(await auth.verify(forged), false, forged);
});

test('configuration is validated and sign-up returns the new user id', async () => {
  assert.throws(() => createNeonAuth({ baseUrl: 'ftp://x', adminUserId: admin.id, origin: 'https://s' }), /base URL/);
  assert.throws(() => createNeonAuth({ baseUrl: base, adminUserId: '', origin: 'https://s' }), /admin user ID/);
  assert.deepEqual(await signUpAdmin({ baseUrl: base, origin: 'https://site.example', email: 'a@b.co', password: 'pw-pw-pw-pw' }), { userId: 'new-user-0003', emailVerified: false });
});

test('the admin setup script creates the account from a password file and never prints it', async () => {
  const { execFile } = await import('node:child_process');
  const { mkdtemp, readFile, rm, stat, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'td-admin-'));
  try {
    await writeFile(join(dir, 'auth-url'), `${base}\n`);
    await writeFile(join(dir, 'pw'), 'a-long-private-password\n', { mode: 0o600 });
    const script = new URL('../scripts/site-admin.mjs', import.meta.url).pathname;
    const run = (...args) => new Promise((resolve) => execFile(process.execPath, [script, '--auth-url-file', join(dir, 'auth-url'), '--state-dir', join(dir, 'state'), ...args], (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })));
    const result = await run('--email', 'f@example.com', '--password-file', join(dir, 'pw'));
    assert.equal(result.code, 0, result.stderr);
    assert.equal((await readFile(join(dir, 'state', 'admin-user-id.txt'), 'utf8')).trim(), 'new-user-0003');
    assert.equal((await stat(join(dir, 'state', 'admin-user-id.txt'))).mode & 0o777, 0o600);
    assert.doesNotMatch(result.stdout + result.stderr, /a-long-private-password/);
    await writeFile(join(dir, 'short'), 'short\n');
    const refused = await run('--email', 'f@example.com', '--password-file', join(dir, 'short'));
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /at least 12/);
    assert.equal((await run('--password-file', join(dir, 'pw'))).code, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('requestReset asks Neon to email a link that returns to our page, and treats outages as errors', async () => {
  const auth = make();
  await auth.requestReset('admin@example.com', '/functions/v1/app/reset');
  const call = seen.filter((c) => c.path === '/request-password-reset').at(-1);
  assert.equal(call.origin, 'https://site.example');
  assert.deepEqual(call.body, { email: 'admin@example.com', redirectTo: 'https://site.example/functions/v1/app/reset' });
  await assert.rejects(auth.requestReset('down@example.com', '/x'), /unavailable/);
});

test('resetPassword distinguishes success, invalid or used tokens, password-policy rejections and outages', async () => {
  const auth = make();
  assert.deepEqual(await auth.resetPassword('good-token-0000000000', 'a-fresh-password-1'), { ok: true });
  assert.deepEqual(await auth.resetPassword('stale-token-000000000', 'a-fresh-password-1'), { ok: false, invalid: true, message: undefined });
  assert.deepEqual(await auth.resetPassword('weak-token-0000000000', 'x'), { ok: false, invalid: false, message: 'Password too short' });
  await assert.rejects(auth.resetPassword('boom-token-0000000000', 'a-fresh-password-1'), /unavailable/);
});

test('the admin id may be looked up on each call; a changed or missing admin admits nobody', async () => {
  let current = admin.id;
  const auth = createNeonAuth({ baseUrl: base, adminUserId: async () => current, origin: 'https://site.example' });
  const result = await auth.login(form({ email: admin.email, password: admin.password }));
  assert.ok(result.session);
  assert.equal(await auth.verify(result.session), true);
  current = 'someone-else-0002';
  assert.equal(await auth.verify(result.session), false);
  assert.equal(await auth.login(form({ email: admin.email, password: admin.password })), undefined);
  current = undefined;
  assert.equal(await auth.verify(result.session), false);
  assert.equal(await auth.login(form({ email: admin.email, password: admin.password })), undefined);
});
