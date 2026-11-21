import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import pg from 'pg';
import { initializeGovernance } from '../src/governance-db.mjs';
import { createTenderDesk } from '../src/governance.mjs';
import { createPoolDatabase, poolTypes } from '../src/pg-database.mjs';
import { parseTenderCsv } from '../src/tender-data.mjs';

const dataset = parseTenderCsv('tender_no,tender_description,agency,award_date,tender_detail_status,supplier_name,awarded_amt\n' + [
  ...[1, 2, 3, 4, 5].map((i) => `OLD-${i},Event management services,Agency A,1/${i}/2025,Awarded to Suppliers,Past supplier,${i * 123456}.00`),
  'NEW-1,Event management services,Agency A,1/1/2026,Awarded to Suppliers,Hidden winner,98765.43',
].join('\n'));
const founderToken = randomBytes(32).toString('hex');
let pglite; let socket; let database; let desk; let founder;

before(async () => {
  pglite = await PGlite.create();
  socket = new PGLiteSocketServer({ db: pglite, port: 0, host: '127.0.0.1' });
  await socket.start();
  const pool = new pg.Pool({ connectionString: `postgres://postgres:postgres@127.0.0.1:${socket.server.address().port}/postgres`, max: 1, ssl: false, types: poolTypes(pg.types) });
  database = createPoolDatabase(pool);
  await initializeGovernance(database);
  desk = createTenderDesk({ database, dataset, founderToken });
  founder = desk.founder(founderToken);
});
after(async () => {
  await database?.close();
  await socket?.stop();
  await pglite?.close();
});

test('the pool adapter migrates once and runs the full governed journey with JSON, bigint, array and timestamp types intact', async () => {
  await initializeGovernance({ query: database.query, exec: () => assert.fail('must not rerun DDL') });
  const a = await founder.createClient({ name: 'Amber Pool', capabilities: 'Events', categories: ['events-community'], team_size: 4, max_contract_cents: 100000000, past_projects: [{ title: 'Festival project', value_cents: 12500000 }] });
  const b = await founder.createClient({ name: 'Birch Pool', capabilities: 'Events', categories: ['events-community'], team_size: 4, max_contract_cents: 100000000, past_projects: [] });
  await founder.verifyProject({ project_id: a.projects[0].id, verified: true });
  const agentA = await desk.agent((await founder.issueAgentCredential({ role: 'client', client_id: a.client_id })).token);
  const agentB = await desk.agent((await founder.issueAgentCredential({ role: 'client', client_id: b.client_id })).token);
  const context = await agentA.invoke('get_client_context', {});
  assert.equal(context.client.max_contract_cents, 100000000);
  assert.deepEqual(context.client.categories, ['events-community']);
  const pricing = await agentA.invoke('request_pricing', { tender_no: 'NEW-1', query: 'event management' });
  assert.equal(pricing.outcome, 'allowed');
  assert.equal((await agentB.invoke('request_pricing', { tender_no: 'NEW-1', query: 'event management' })).outcome, 'escalated');
  const brief = await agentA.invoke('submit_brief', { tender_no: 'NEW-1', stat_id: pricing.stat_id, price_band: pricing.price_band, recommendation: 'bid', content: 'Check capacity.', credentials_cited: [a.projects[0].id] });
  assert.equal(brief.outcome, 'allowed');
  const state = await founder.readConsole();
  const stored = state.briefs.find((x) => x.id === brief.brief_id);
  assert.deepEqual(stored.price_band, pricing.price_band);
  assert.deepEqual(stored.credentials_cited, [a.projects[0].id]);
  assert.ok(stored.created_at instanceof Date);
  assert.equal(typeof state.projects[0].value_cents, 'number');
  assert.equal((await founder.reviewBrief({ brief_id: brief.brief_id, decision: 'approved' })).outcome, 'approved');
});

test('a rolled-back pool transaction leaves nothing behind, row locks work, and append-only triggers hold', async () => {
  const before = (await database.query('SELECT count(*)::int AS n FROM tender_desk.clients')).rows[0].n;
  await assert.rejects(database.transaction(async (tx) => {
    await tx.query("INSERT INTO tender_desk.clients (name,capabilities,categories,team_size,max_contract_cents) VALUES ('Ghost','x',ARRAY['other'],1,1)");
    throw new Error('abort');
  }), /abort/);
  assert.equal((await database.query('SELECT count(*)::int AS n FROM tender_desk.clients')).rows[0].n, before);
  assert.equal(await database.transaction(async (tx) => (await tx.query('SELECT id FROM tender_desk.clients ORDER BY id LIMIT 1 FOR UPDATE')).rows.length), 1);
  await assert.rejects(database.query('DELETE FROM tender_desk.audit_log'), { code: '55000' });
});
