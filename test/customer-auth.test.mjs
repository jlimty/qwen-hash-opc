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
