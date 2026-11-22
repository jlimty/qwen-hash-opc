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
let pglite; let socket; let auth; let dir; let dbFile; let authFile; const signups = []; let failBramble = true;

before(async () => {
  pglite = await PGlite.create();
  await initializeGovernance(pglite);
  socket = new PGLiteSocketServer({ db: pglite, port: 0, host: '127.0.0.1' });
  await socket.start();
  auth = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    if (req.url !== '/sign-up/email') return res.writeHead(404).end('{}');
    if (failBramble && body.email.includes('bramble')) { failBramble = false; return res.writeHead(503, { 'Content-Type': 'application/json' }).end('{"message":"busy"}'); }
    signups.push(body);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `__Secure-neon-auth.session_token=t${randomBytes(4).toString('hex')}; Path=/` })
      .end(JSON.stringify({ user: { id: `user-${randomBytes(6).toString('hex')}` } }));
  });
  auth.listen(0, '127.0.0.1'); await once(auth, 'listening');
  dir = await mkdtemp(join(tmpdir(), 'td-test-customers-resume-'));
  dbFile = join(dir, 'db.url'); authFile = join(dir, 'auth.url');
  await writeFile(dbFile, `postgres://postgres:postgres@127.0.0.1:${socket.server.address().port}/postgres?sslmode=disable\n`);
  await writeFile(authFile, `http://127.0.0.1:${auth.address().port}\n`);
});
after(async () => { auth?.close(); await socket?.stop(); await pglite?.close(); await rm(dir, { recursive: true, force: true }); });

const seed = () => run(process.execPath, [script, '--db-file', dbFile, '--auth-url-file', authFile, '--state-dir', dir])
  .then((r) => ({ ...r, code: 0 }), (e) => ({ stdout: e.stdout, stderr: e.stderr, code: e.code }));

test('a failure part-way keeps the accounts already made, and a rerun finishes the rest', async () => {
  const first = await seed();
  assert.notEqual(first.code, 0);
  const file = join(dir, 'test-customers.json');
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).map((c) => c.label), ['aster']);
  const second = await seed();
  assert.equal(second.code, 0, second.stderr);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).map((c) => c.label), ['aster', 'bramble', 'clover']);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await pglite.query('SELECT count(*)::int AS n FROM tender_desk.customers')).rows[0].n, 3);
});
