import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { promisify } from 'node:util';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const run = promisify(execFile);
const script = new URL('../scripts/site-seed.mjs', import.meta.url).pathname;
let pglite; let socket; let dir; let dbFile;

before(async () => {
  pglite = await PGlite.create();
  socket = new PGLiteSocketServer({ db: pglite, port: 0, host: '127.0.0.1' });
  await socket.start();
  dir = await mkdtemp(join(tmpdir(), 'td-site-seed-'));
  dbFile = join(dir, 'db-url.txt');
  await writeFile(dbFile, `postgres://postgres:postgres@127.0.0.1:${socket.server.address().port}/postgres?sslmode=disable\n`, { mode: 0o600 });
});
after(async () => {
  await socket?.stop();
  await pglite?.close();
  await rm(dir, { recursive: true, force: true });
});

const seed = (...args) => run(process.execPath, [script, '--db-file', dbFile, '--state-dir', join(dir, 'state'), ...args]).then((r) => ({ ...r, code: 0 }), (e) => ({ stdout: e.stdout, stderr: e.stderr, code: e.code }));

test('--check connects and changes nothing', async () => {
  const result = await seed('--check');
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Connected to PostgreSQL .*Nothing was changed/);
  assert.equal((await pglite.query("SELECT to_regclass('tender_desk.clients') AS r")).rows[0].r, null);
});

test('seeding migrates, creates fictional clients and private credential files, and prints no secrets', async () => {
  const result = await seed();
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /demo clients seeded/);
  assert.equal((await pglite.query('SELECT count(*)::int AS n FROM tender_desk.clients')).rows[0].n, 2);
  assert.equal((await pglite.query('SELECT count(*)::int AS n FROM tender_desk.agent_credentials')).rows[0].n, 3);
  const founder = (await readFile(join(dir, 'state', 'founder-token.txt'), 'utf8')).trim();
  assert.match(founder, /^[a-f0-9]{64}$/);
  const tokens = await readdir(join(dir, 'state', 'agent-tokens'));
  assert.deepEqual(tokens.sort(), ['amber.txt', 'birch.txt', 'intake.txt']);
  for (const file of tokens) {
    assert.equal((await stat(join(dir, 'state', 'agent-tokens', file))).mode & 0o777, 0o600);
    const secret = (await readFile(join(dir, 'state', 'agent-tokens', file), 'utf8')).trim().replace('Bearer ', '');
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(secret));
  }
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(founder));
});

test('a second run refuses to reseed and a missing URL file is reported plainly', async () => {
  const again = await seed();
  assert.equal(again.code, 1);
  assert.match(again.stderr, /already has clients/);
  assert.equal((await pglite.query('SELECT count(*)::int AS n FROM tender_desk.clients')).rows[0].n, 2);
  const missing = await run(process.execPath, [script, '--db-file', join(dir, 'nope.txt'), '--check']).catch((e) => e);
  assert.match(missing.stderr, /Could not read the database URL file/);
});
