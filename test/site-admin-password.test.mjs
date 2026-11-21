import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { hashPassword, verifyPassword } from '../src/neon-password.mjs';
import { chooseNewPassword } from '../scripts/lib/prompt.mjs';

const script = new URL('../scripts/site-admin-password.mjs', import.meta.url).pathname;
const adminId = '00000000-0000-4000-8000-000000000001';
const otherId = '9b5651fa-7b0e-44cd-a353-c9a7e25faa2f';
let pglite; let socket; let dir;

before(async () => {
  pglite = await PGlite.create();
  await pglite.exec(`CREATE SCHEMA neon_auth;
    CREATE TABLE neon_auth."user" (id text PRIMARY KEY, email text NOT NULL);
    CREATE TABLE neon_auth.account (id text PRIMARY KEY, "accountId" text, "providerId" text, "userId" text, password text, "createdAt" timestamptz, "updatedAt" timestamptz);
    CREATE TABLE neon_auth.session (id text PRIMARY KEY, "userId" text, token text);`);
  const old = await hashPassword('the-old-forgotten-password');
  await pglite.query(`INSERT INTO neon_auth."user" VALUES ($1,'admin@example.com'),($2,'other@example.com')`, [adminId, otherId]);
  await pglite.query(`INSERT INTO neon_auth.account VALUES ('a1',$1,'credential',$1,$3,now(),now()),('a2',$2,'credential',$2,$3,now(),now())`, [adminId, otherId, old]);
  await pglite.query(`INSERT INTO neon_auth.session VALUES ('s1',$1,'t1'),('s2',$2,'t2')`, [adminId, otherId]);
  socket = new PGLiteSocketServer({ db: pglite, port: 0, host: '127.0.0.1' });
  await socket.start();
  dir = await mkdtemp(join(tmpdir(), 'td-pw-'));
  await writeFile(join(dir, 'admin-user-id.txt'), `${adminId}\n`);
  await writeFile(join(dir, 'db-unpooled.url'), `postgres://postgres:postgres@127.0.0.1:${socket.server.address().port}/postgres?sslmode=disable\n`);
});
after(async () => {
  await socket?.stop();
  await pglite?.close();
  await rm(dir, { recursive: true, force: true });
});

const run = (...args) => new Promise((resolve) => execFile(process.execPath, [script, '--state-dir', dir, ...args], (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })));

test('the prompt asks twice and refuses short passwords and mismatches', async () => {
  const answers = (...list) => { const queue = [...list]; return async () => queue.shift(); };
  assert.equal(await chooseNewPassword(answers('a-strong-password', 'a-strong-password')), 'a-strong-password');
  await assert.rejects(chooseNewPassword(answers('short', 'short')), /at least 12/);
  await assert.rejects(chooseNewPassword(answers('a-strong-password', 'a-strong-passwor')), /did not match/);
});

test('refuses a short password and an unknown admin, changing nothing', async () => {
  await writeFile(join(dir, 'short'), 'short\n');
  const short = await run('--password-file', join(dir, 'short'));
  assert.equal(short.code, 1);
  assert.match(short.stderr, /at least 12/);
  assert.equal(await verifyPassword('the-old-forgotten-password', (await pglite.query(`SELECT password FROM neon_auth.account WHERE id='a1'`)).rows[0].password), true);
  await writeFile(join(dir, 'admin-user-id.txt'), 'unknown-user-id-0000\n');
  const unknown = await run('--password-file', join(dir, 'short'));
  assert.match(unknown.stderr, /does not match any account/);
  await writeFile(join(dir, 'admin-user-id.txt'), `${adminId}\n`);
});

test('resets the admin password, signs the admin out everywhere, leaves other accounts alone, and never prints the password', async () => {
  await writeFile(join(dir, 'pw'), 'a-brand-new-password-1\n', { mode: 0o600 });
  const result = await run('--password-file', join(dir, 'pw'));
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Setting a new password for admin@example\.com/);
  assert.doesNotMatch(result.stdout + result.stderr, /a-brand-new-password-1/);
  const admin = (await pglite.query(`SELECT password FROM neon_auth.account WHERE id='a1'`)).rows[0].password;
  assert.equal(await verifyPassword('a-brand-new-password-1', admin), true);
  assert.equal(await verifyPassword('the-old-forgotten-password', admin), false);
  assert.equal((await pglite.query(`SELECT count(*)::int AS n FROM neon_auth.session WHERE "userId"=$1`, [adminId])).rows[0].n, 0);
  assert.equal((await pglite.query(`SELECT count(*)::int AS n FROM neon_auth.session WHERE "userId"=$1`, [otherId])).rows[0].n, 1);
  const other = (await pglite.query(`SELECT password FROM neon_auth.account WHERE id='a2'`)).rows[0].password;
  assert.equal(await verifyPassword('the-old-forgotten-password', other), true);
});
