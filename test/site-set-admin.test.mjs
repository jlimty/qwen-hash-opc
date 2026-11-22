import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { initializeGovernance } from '../src/governance-db.mjs';

const script = new URL('../scripts/site-set-admin.mjs', import.meta.url).pathname;
const first = '00000000-0000-4000-8000-000000000001';
const second = '9b5651fa-7b0e-44cd-a353-c9a7e25faa2f';
let pglite; let socket; let dir;

before(async () => {
  pglite = await PGlite.create();
  await initializeGovernance(pglite);
  socket = new PGLiteSocketServer({ db: pglite, port: 0, host: '127.0.0.1' });
  await socket.start();
  dir = await mkdtemp(join(tmpdir(), 'td-set-admin-'));
  await writeFile(join(dir, 'db-unpooled.url'), `postgres://postgres:postgres@127.0.0.1:${socket.server.address().port}/postgres?sslmode=disable\n`);
});
after(async () => { await socket?.stop(); await pglite?.close(); await rm(dir, { recursive: true, force: true }); });

const run = () => new Promise((resolve) => execFile(process.execPath, [script, '--state-dir', dir], (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })));
const stored = async () => (await pglite.query("SELECT value FROM tender_desk.settings WHERE key = 'admin_user_id'")).rows[0]?.value;

test('records the admin user ID from the state directory, and a later run replaces it', async () => {
  await writeFile(join(dir, 'admin-user-id.txt'), `${first}\n`);
  assert.equal((await run()).code, 0);
  assert.equal(await stored(), first);
  await writeFile(join(dir, 'admin-user-id.txt'), `${second}\n`);
  assert.equal((await run()).code, 0);
  assert.equal(await stored(), second);
});

test('refuses a malformed ID and leaves the stored admin alone', async () => {
  await writeFile(join(dir, 'admin-user-id.txt'), 'not a valid id\n');
  const result = await run();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /valid user ID/);
  assert.equal(await stored(), second);
});
