import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { promisify } from 'node:util';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const run = promisify(execFile);
const script = new URL('../scripts/site-migrate.mjs', import.meta.url).pathname;
let pglite; let socket; let dir; let dbFile;

before(async () => {
  pglite = await PGlite.create();
  for (const file of ['001-governance.sql', '002-journey.sql']) await pglite.exec(await readFile(new URL(`../db/${file}`, import.meta.url), 'utf8'));
  await pglite.query(`INSERT INTO tender_desk.clients (name,capabilities,categories,team_size,max_contract_cents) VALUES ('Live Client','Events',ARRAY['events-community'],3,100)`);
  socket = new PGLiteSocketServer({ db: pglite, port: 0, host: '127.0.0.1' });
  await socket.start();
  dir = await mkdtemp(join(tmpdir(), 'td-site-migrate-'));
  dbFile = join(dir, 'db-url.txt');
  await writeFile(dbFile, `postgres://postgres:postgres@127.0.0.1:${socket.server.address().port}/postgres?sslmode=disable\n`, { mode: 0o600 });
});
after(async () => { await socket?.stop(); await pglite?.close(); await rm(dir, { recursive: true, force: true }); });

const migrate = (...args) => run(process.execPath, [script, '--db-file', dbFile, ...args]).then((r) => ({ ...r, code: 0 }), (e) => ({ stdout: e.stdout, stderr: e.stderr, code: e.code }));

test('--check lists the pending migration and changes nothing', async () => {
  const result = await migrate('--check');
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Target host: 127\.0\.0\.1/);
  assert.match(result.stdout, /Pending: 003-assistant\.sql, 004-settings\.sql/);
  assert.equal((await pglite.query("SELECT to_regclass('tender_desk.brief_requests') AS r")).rows[0].r, null);
});

test('migrating applies 003 and 004 in place and keeps every client', async () => {
  const result = await migrate();
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Clients before: 1, after: 1/);
  assert.notEqual((await pglite.query("SELECT to_regclass('tender_desk.brief_requests') AS r")).rows[0].r, null);
  assert.notEqual((await pglite.query("SELECT to_regclass('tender_desk.settings') AS r")).rows[0].r, null);
  const again = await migrate('--check');
  assert.match(again.stdout, /Pending: none/);
});
