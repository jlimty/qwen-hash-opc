import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { promisify } from 'node:util';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { initializeGovernance } from '../src/governance-db.mjs';
import { createTenderDesk } from '../src/governance.mjs';
import { parseTenderCsv } from '../src/tender-data.mjs';

const run = promisify(execFile);
const script = new URL('../scripts/site-revoke-legacy.mjs', import.meta.url).pathname;
let pglite; let socket; let dir; let dbFile;

before(async () => {
  pglite = await PGlite.create();
  await initializeGovernance(pglite);
  const token = randomBytes(32).toString('hex');
  const admin = createTenderDesk({ database: pglite, dataset: parseTenderCsv('tender_no,tender_description,agency,award_date,tender_detail_status,supplier_name,awarded_amt\nA1,Event,Agency,1/1/2025,Awarded to Suppliers,S,1000.00'), adminToken: token }).admin(token);
  const client = await admin.createClient({ name: 'Legacy Co', capabilities: 'x', categories: ['other'], team_size: 1, max_contract_cents: 1, past_projects: [] });
  await admin.issueAgentCredential({ role: 'client', client_id: client.client_id });
  await admin.issueAgentCredential({ role: 'intake' });
  await admin.issueAgentCredential({ role: 'operator' });
  socket = new PGLiteSocketServer({ db: pglite, port: 0, host: '127.0.0.1' });
  await socket.start();
  dir = await mkdtemp(join(tmpdir(), 'td-revoke-'));
  dbFile = join(dir, 'db.url');
  await writeFile(dbFile, `postgres://postgres:postgres@127.0.0.1:${socket.server.address().port}/postgres?sslmode=disable\n`);
});
after(async () => { await socket?.stop(); await pglite?.close(); await rm(dir, { recursive: true, force: true }); });

const revoke = (...args) => run(process.execPath, [script, '--db-file', dbFile, ...args]).then((r) => ({ ...r, code: 0 }), (e) => ({ stdout: e.stdout, stderr: e.stderr, code: e.code }));

test('--check lists the customer and intake keys and changes nothing', async () => {
  const result = await revoke('--check');
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /client: 1, intake: 1/);
  assert.equal((await pglite.query('SELECT count(*)::int AS n FROM tender_desk.agent_credentials')).rows[0].n, 3);
});

test('revoking removes customer and intake keys through the audited admin path, and keeps the operator key', async () => {
  const result = await revoke();
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Revoked 2/);
  assert.deepEqual((await pglite.query('SELECT role FROM tender_desk.agent_credentials')).rows.map((r) => r.role), ['operator']);
  assert.equal((await pglite.query("SELECT count(*)::int AS n FROM tender_desk.audit_log WHERE action='revoke_agent_credential'")).rows[0].n, 2);
});
