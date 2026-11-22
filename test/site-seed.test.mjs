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

test('seeding creates Birch and a public intake only, with private credential and connector files, and prints no secrets', async () => {
  const result = await seed();
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /demo clients seeded/);
  const clients = (await pglite.query('SELECT name FROM tender_desk.clients')).rows.map((r) => r.name);
  assert.deepEqual(clients, ['Birch Events (demo)']);
  assert.equal((await pglite.query('SELECT count(*)::int AS n FROM tender_desk.agent_credentials')).rows[0].n, 2);
  assert.equal((await pglite.query("SELECT verification_note FROM tender_desk.projects WHERE verified")).rows[0].verification_note, 'Seeded demo client (fictional).');
  const admin = (await readFile(join(dir, 'state', 'admin-token.txt'), 'utf8')).trim();
  assert.match(admin, /^[a-f0-9]{64}$/);
  const tokens = await readdir(join(dir, 'state', 'agent-tokens'));
  assert.deepEqual(tokens.sort(), ['birch.txt', 'intake.txt']);
  const connectors = (await readdir(join(dir, 'state', 'connectors'))).sort();
  assert.deepEqual(connectors, ['tender-desk-birch.json', 'tender-desk-intake.json']);
  for (const file of connectors) assert.equal((await stat(join(dir, 'state', 'connectors', file))).mode & 0o777, 0o600);
  const intake = JSON.parse(await readFile(join(dir, 'state', 'connectors', 'tender-desk-intake.json'), 'utf8')).mcpServers['tender-desk-intake'];
  assert.equal(intake.url, 'https://tender-desk-bz2oc52nag4.qoder.website/functions/v1/app/mcp');
  for (const file of tokens) {
    assert.equal((await stat(join(dir, 'state', 'agent-tokens', file))).mode & 0o777, 0o600);
    const secret = (await readFile(join(dir, 'state', 'agent-tokens', file), 'utf8')).trim().replace('Bearer ', '');
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(secret));
  }
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(admin));
});

test('a second run refuses to reseed and a missing URL file is reported plainly', async () => {
  const again = await seed();
  assert.equal(again.code, 1);
  assert.match(again.stderr, /already has clients/);
  assert.equal((await pglite.query('SELECT count(*)::int AS n FROM tender_desk.clients')).rows[0].n, 1);
  const missing = await run(process.execPath, [script, '--db-file', join(dir, 'nope.txt'), '--check']).catch((e) => e);
  assert.match(missing.stderr, /Could not read the database URL file/);
});

const reseedScript = new URL('../scripts/site-reseed.mjs', import.meta.url).pathname;
const reseed = (...args) => run(process.execPath, [reseedScript, '--db-file', dbFile, '--state-dir', join(dir, 'state'), ...args])
  .then((r) => ({ ...r, code: 0 }), (e) => ({ stdout: e.stdout, stderr: e.stderr, code: e.code }));

test('reseed refuses without the explicit flag and changes nothing', async () => {
  const before = (await pglite.query('SELECT count(*)::int AS n FROM tender_desk.audit_log')).rows[0].n;
  const result = await reseed();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /--yes-wipe-tender-desk/);
  assert.equal((await pglite.query('SELECT count(*)::int AS n FROM tender_desk.audit_log')).rows[0].n, before);
});

test('reseed drops and rebuilds tender_desk only, and keeps the old credential files aside', async () => {
  await pglite.exec('CREATE SCHEMA IF NOT EXISTS keepme; CREATE TABLE IF NOT EXISTS keepme.users (id int); INSERT INTO keepme.users VALUES (1);');
  await pglite.query("INSERT INTO tender_desk.clients (name,capabilities,categories,team_size,max_contract_cents) VALUES ('Stray Co','x','{other}',1,1)");
  const result = await reseed('--yes-wipe-tender-desk');
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /127\.0\.0\.1/);
  assert.deepEqual((await pglite.query('SELECT name FROM tender_desk.clients')).rows.map((r) => r.name), ['Birch Events (demo)']);
  assert.equal((await pglite.query('SELECT count(*)::int AS n FROM keepme.users')).rows[0].n, 1);
  const entries = await readdir(join(dir, 'state'));
  assert.ok(entries.some((e) => /^agent-tokens\.before-reseed-/.test(e)), entries.join());
  assert.ok(entries.some((e) => /^connectors\.before-reseed-/.test(e)), entries.join());
  const birch = (await readFile(join(dir, 'state', 'agent-tokens', 'birch.txt'), 'utf8')).trim().replace('Bearer ', '');
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(birch));
});

test('the starter pack holds the intake connector and one zip per client skill', async () => {
  const pack = new URL('../scripts/starter-pack.mjs', import.meta.url).pathname;
  const result = await run(process.execPath, [pack, '--state-dir', join(dir, 'state')]);
  assert.match(result.stdout, /starter-pack/);
  const out = join(dir, 'state', 'starter-pack');
  assert.deepEqual((await readdir(out)).sort(), ['README.txt', 'tender-desk-analyst.zip', 'tender-desk-intake.json', 'tender-desk-intake.zip',
    'tender-desk-proposal.zip', 'tender-desk-scout.zip']);
  const listing = (await run('unzip', ['-l', join(out, 'tender-desk-analyst.zip')])).stdout;
  assert.match(listing, /\sSKILL\.md\n/);
  assert.match(await readFile(join(out, 'README.txt'), 'utf8'), /Register my company/);
});

test('reseed into a fresh state folder works, and prepares everything before dropping anything', async () => {
  const fresh = join(dir, 'fresh-state');
  const result = await run(process.execPath, [reseedScript, '--db-file', dbFile, '--state-dir', fresh, '--yes-wipe-tender-desk'])
    .then((r) => ({ ...r, code: 0 }), (e) => ({ stdout: e.stdout, stderr: e.stderr, code: e.code }));
  assert.equal(result.code, 0, result.stderr);
  assert.equal((await stat(join(fresh, 'admin-token.txt'))).mode & 0o777, 0o600);
  assert.deepEqual((await pglite.query('SELECT name FROM tender_desk.clients')).rows.map((r) => r.name), ['Birch Events (demo)']);
});
