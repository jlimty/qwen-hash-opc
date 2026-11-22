import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { createCustomerAuth } from '../src/customer-auth.mjs';

const adminUserId = 'admin-user-0001';
function fakeNeonAuth() {
  const users = new Map([['admin@example.com', { id: adminUserId, password: 'admin password long' }]]);
  const sessions = new Map();
  const calls = [];
  const json = (status, body, cookie) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json',
    ...(cookie && { 'Set-Cookie': `__Secure-neon-auth.session_token=${cookie}; Path=/; HttpOnly; Secure` }) } });
  const issue = (user) => { const value = `tok-${randomBytes(6).toString('hex')}.sig`; sessions.set(value, user.id); return value; };
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname.replace(/^\/auth/, '');
    calls.push({ path, origin: init.headers?.Origin });
    const body = init.body ? JSON.parse(init.body) : {};
    if (path === '/sign-up/email') {
      if (users.has(body.email)) return json(422, { message: 'User already exists' });
      const user = { id: `user-${randomBytes(6).toString('hex')}`, password: body.password };
      users.set(body.email, user);
      return json(200, { user: { id: user.id } }, issue(user));
    }
    if (path === '/sign-in/email') {
      const user = users.get(body.email);
      if (!user || user.password !== body.password) return json(401, { message: 'Invalid email or password' });
      return json(200, { user: { id: user.id } }, issue(user));
    }
    if (path === '/get-session') {
      const token = /session_token=([^;]+)/.exec(init.headers?.Cookie ?? '')?.[1];
      const id = sessions.get(token);
      return id ? json(200, { user: { id }, session: { expiresAt: new Date(Date.now() + 3600000).toISOString() } }) : json(200, null);
    }
    if (path === '/sign-out') return json(200, { success: true });
    return json(404, {});
  };
  return { fetchImpl, calls };
}
const make = () => { const fake = fakeNeonAuth(); return { fake, auth: createCustomerAuth({ baseUrl: 'https://auth.example/auth', origin: 'https://site.example', adminUserId, fetchImpl: fake.fetchImpl }) }; };

test('sign up then verify returns the new user id', async () => {
  const { auth, fake } = make();
  const result = await auth.signUp({ email: 'owner@sme.example', password: 'a long password', name: 'Owner' });
  assert.equal(result.ok, true);
  assert.match(result.userId, /^user-/);
  assert.equal(await auth.verify(result.session), result.userId);
  assert.equal(fake.calls[0].origin, 'https://site.example');
});

test('a short password is refused before calling Neon Auth', async () => {
  const { auth, fake } = make();
  assert.deepEqual(await auth.signUp({ email: 'a@b.example', password: 'short', name: 'A' }), { ok: false, message: 'Use a password of at least 8 characters.' });
  assert.equal(fake.calls.length, 0);
});

test('a duplicate sign-up and a wrong password are refused', async () => {
  const { auth } = make();
  await auth.signUp({ email: 'owner@sme.example', password: 'a long password', name: 'Owner' });
  const again = await auth.signUp({ email: 'owner@sme.example', password: 'a long password', name: 'Owner' });
  assert.equal(again.ok, false);
  assert.equal((await auth.signIn({ email: 'owner@sme.example', password: 'wrong password' })).ok, false);
  const ok = await auth.signIn({ email: 'owner@sme.example', password: 'a long password' });
  assert.equal(ok.ok, true);
});

test('the admin cannot use the assistant as a customer', async () => {
  const { auth } = make();
  const result = await auth.signIn({ email: 'admin@example.com', password: 'admin password long' });
  assert.equal(result.ok, false);
});

test('verify rejects a tampered or missing session', async () => {
  const { auth } = make();
  assert.equal(await auth.verify('nonsense'), undefined);
  assert.equal(await auth.verify(undefined), undefined);
});
