import assert from 'node:assert/strict';
import test from 'node:test';
import { hashPassword, verifyPassword } from '../src/neon-password.mjs';

test('hashes use the Better Auth scrypt layout: 32 hex salt, colon, 128 hex key, fresh salt each time', async () => {
  const [one, two] = await Promise.all([hashPassword('correct horse battery'), hashPassword('correct horse battery')]);
  assert.match(one, /^[0-9a-f]{32}:[0-9a-f]{128}$/);
  assert.notEqual(one, two);
});

test('verification accepts the right password and rejects wrong, empty and malformed input', async () => {
  const stored = await hashPassword('correct horse battery');
  assert.equal(await verifyPassword('correct horse battery', stored), true);
  assert.equal(await verifyPassword('correct horse batterx', stored), false);
  assert.equal(await verifyPassword('', stored), false);
  for (const bad of ['', 'nope', 'abc:def', undefined]) assert.equal(await verifyPassword('correct horse battery', bad), false);
});

test('equivalent Unicode forms of a password match, as Better Auth normalises with NFKC', async () => {
  const stored = await hashPassword('caf\u00e9-password-1');
  assert.equal(await verifyPassword('cafe\u0301-password-1', stored), true);
});
