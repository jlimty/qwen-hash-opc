import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCustomerAuth } from '../src/customer-auth.mjs';
import { fakeNeonAuth } from './support/fake-neon-auth.mjs';

const adminUserId = 'admin-user-0001';
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

test('the admin id may be looked up on each call, so the admin can change without a restart', async () => {
  const fake = fakeNeonAuth();
  let current = adminUserId;
  const auth = createCustomerAuth({ baseUrl: 'https://auth.example/auth', origin: 'https://site.example', adminUserId: async () => current, fetchImpl: fake.fetchImpl });
  const admin = { email: 'admin@example.com', password: 'admin password long' };
  assert.equal((await auth.signIn(admin)).ok, false);
  current = 'someone-else-0002';
  assert.equal((await auth.signIn(admin)).ok, true);
});

test('with email verification on, sign-up opens no session and sign-in waits for the link', async () => {
  const fake = fakeNeonAuth({ requireVerification: true });
  const auth = createCustomerAuth({ baseUrl: 'https://auth.example/auth', origin: 'https://site.example', adminUserId, fetchImpl: fake.fetchImpl });
  const signed = await auth.signUp({ email: 'new@sme.example', password: 'a long password', name: 'New', callbackPath: '/app/signin' });
  assert.equal(signed.ok, true);
  assert.equal(signed.verifyEmail, true);
  assert.equal(signed.session, null);
  assert.match(signed.userId, /^user-/);
  assert.equal(fake.calls[0].body.callbackURL, 'https://site.example/app/signin');
  const early = await auth.signIn({ email: 'new@sme.example', password: 'a long password' });
  assert.equal(early.ok, false);
  assert.match(early.message, /verify your email/i);
  fake.verifyEmail('new@sme.example');
  assert.equal((await auth.signIn({ email: 'new@sme.example', password: 'a long password' })).ok, true);
});
