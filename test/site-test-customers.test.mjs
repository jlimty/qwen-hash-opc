import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { promisify } from 'node:util';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { initializeGovernance } from '../src/governance-db.mjs';

const run = promisify(execFile);
const script = new URL('../scripts/site-test-customers.mjs', import.meta.url).pathname;
let pglite; let socket; let auth; let dir; let dbFile; let authFile; const signups = [];

before(async () => {
  pglite = await PGlite.create();
  await initializeGovernance(pglite);
  // Neon Auth keeps its users in the same database, in neon_auth."user".
  await pglite.exec('CREATE SCHEMA neon_auth; CREATE TABLE neon_auth."user" (id text PRIMARY KEY, email text NOT NULL, "emailVerified" boolean NOT NULL DEFAULT false);');
  socket = new PGLiteSocketServer({ db: pglite, port: 0, host: '127.0.0.1' });
  await socket.start();
  auth = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    if (req.url !== '/sign-up/email') return res.writeHead(404).end('{}');
    signups.push(body);
    // Email verification is on: the account is created unverified and no session is opened.
    const id = `user-${randomBytes(6).toString('hex')}`;
    await pglite.query('INSERT INTO neon_auth."user" (id,email) VALUES ($1,$2)', [id, body.email]);
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ token: null, user: { id, emailVerified: false } }));
  });
  auth.listen(0, '127.0.0.1'); await once(auth, 'listening');
  dir = await mkdtemp(join(tmpdir(), 'td-test-customers-'));
  dbFile = join(dir, 'db.url'); authFile = join(dir, 'auth.url');
  await writeFile(dbFile, `postgres://postgres:postgres@127.0.0.1:${socket.server.address().port}/postgres?sslmode=disable\n`);
  await writeFile(authFile, `http://127.0.0.1:${auth.address().port}\n`);
});
after(async () => { auth?.close(); await socket?.stop(); await pglite?.close(); await rm(dir, { recursive: true, force: true }); });

const seed = () => run(process.execPath, [script, '--db-file', dbFile, '--auth-url-file', authFile, '--state-dir', dir])
  .then((r) => ({ ...r, code: 0 }), (e) => ({ stdout: e.stdout, stderr: e.stderr, code: e.code }));

test('seeds three labelled test customers with mixed verification and a private credentials file', async () => {
  const result = await seed();
  assert.equal(result.code, 0, result.stderr);
  const clients = (await pglite.query('SELECT c.name, count(p.*) FILTER (WHERE p.verified)::int AS checked, count(p.*)::int AS total FROM tender_desk.clients c JOIN tender_desk.customers u ON u.client_id=c.id LEFT JOIN tender_desk.projects p ON p.client_id=c.id GROUP BY c.name ORDER BY c.name')).rows;
  assert.equal(clients.length, 3);
  assert.ok(clients.every((c) => c.name.endsWith('(test)')));
  assert.deepEqual(clients.map((c) => [c.checked, c.total]), [[2, 2], [1, 2], [0, 1]]);
  const file = join(dir, 'test-customers.json');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.length, 3);
  for (const entry of saved) {
    assert.match(entry.email, /^test\+[a-z]+@tenderdesk\.invalid$/);
    assert.equal(entry.password.length, 20);
    assert.ok(!result.stdout.includes(entry.password));
  }
  assert.deepEqual(signups.map((s) => s.email), saved.map((s) => s.email));
  // The .invalid addresses can never receive a verification email, so the script marks its own accounts verified.
  const verified = (await pglite.query('SELECT email, "emailVerified" FROM neon_auth."user" ORDER BY email')).rows;
  assert.equal(verified.length, 3);
  assert.ok(verified.every((u) => u.emailVerified === true));
});

test('refuses to run twice', async () => {
  const result = await seed();
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /already exists/);
});
