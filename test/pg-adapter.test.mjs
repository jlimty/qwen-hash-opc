import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import postgres from 'postgres';
import { initializeGovernance } from '../src/governance-db.mjs';
import { createTenderDesk } from '../src/governance.mjs';
import { connectPg, createPgDatabase } from '../src/pg-database.mjs';
import { parseTenderCsv } from '../src/tender-data.mjs';

const dataset = parseTenderCsv('tender_no,tender_description,agency,award_date,tender_detail_status,supplier_name,awarded_amt\n' + [
  ...[1, 2, 3, 4, 5].map((i) => `OLD-${i},Event management services,Agency A,1/${i}/2025,Awarded to Suppliers,Past supplier,${i * 123456}.00`),
  'NEW-1,Event management services,Agency A,1/1/2026,Awarded to Suppliers,Hidden winner,98765.43',
  'NEW-2,Event management services,Agency A,1/1/2026,Awarded to Suppliers,Past supplier,300000.00',
].join('\n'));
const founderToken = randomBytes(32).toString('hex');
let pglite; let server; let sql; let database; let desk; let founder;

before(async () => {
  pglite = await PGlite.create();
  server = new PGLiteSocketServer({ db: pglite, port: 0, host: '127.0.0.1' });
  await server.start();
  const { port } = server.server.address();
  sql = connectPg(postgres, `postgres://postgres:postgres@127.0.0.1:${port}/postgres`, { max: 1, ssl: false });
  database = createPgDatabase(sql);
  await initializeGovernance(database);
  desk = createTenderDesk({ database, dataset, founderToken });
  founder = desk.founder(founderToken);
});
after(async () => {
  await database?.close();
  await server?.stop();
  await pglite?.close();
});

const profile = (name) => ({ name, capabilities: 'Events', categories: ['events-community'], team_size: 4, max_contract_cents: 100000000,
  past_projects: [{ title: 'Festival project', value_cents: 12500000 }] });

test('the governance schema migrates once over the Postgres wire protocol', async () => {
  const tables = (await database.query("SELECT table_name FROM information_schema.tables WHERE table_schema='tender_desk' ORDER BY 1")).rows.map((r) => r.table_name);
  assert.deepEqual(tables, ['agent_credentials', 'audit_log', 'briefs', 'clients', 'conflicts', 'pricing_holds', 'projects', 'shortlists', 'stats_snapshots']);
  await initializeGovernance({ query: database.query, exec: () => assert.fail('must not rerun DDL') });
});

test('the full governed journey works: pricing hold, escalation, brief, approval, with JSON, bigint and arrays intact', async () => {
  const a = await founder.createClient(profile('Amber Wire'));
  const b = await founder.createClient(profile('Birch Wire'));
  await founder.verifyProject({ project_id: a.projects[0].id, verified: true, note: 'Checked by the admin (test).' });
  const agentA = await desk.agent((await founder.issueAgentCredential({ role: 'client', client_id: a.client_id })).token);
  const agentB = await desk.agent((await founder.issueAgentCredential({ role: 'client', client_id: b.client_id })).token);

  const context = await agentA.invoke('get_client_context', {});
  assert.equal(context.client.max_contract_cents, 100000000);
  assert.deepEqual(context.client.categories, ['events-community']);

  const pricing = await agentA.invoke('request_pricing', { tender_no: 'NEW-1', query: 'event management' });
  assert.equal(pricing.outcome, 'allowed');
  assert.equal(typeof pricing.price_band.low_cents, 'number');
  const brief = await agentA.invoke('submit_brief', { tender_no: 'NEW-1', stat_id: pricing.stat_id, price_band: pricing.price_band,
    recommendation: 'bid', content: 'Check capacity before bidding.', credentials_cited: [a.projects[0].id] });
  assert.equal(brief.outcome, 'allowed');
  const pricingB = await agentB.invoke('request_pricing', { tender_no: 'NEW-1', query: 'event management' });
  const escalated = await agentB.invoke('submit_brief', { tender_no: 'NEW-1', stat_id: pricingB.stat_id, price_band: pricingB.price_band,
    recommendation: 'bid', content: 'Check capacity before bidding.' });
  assert.equal(escalated.outcome, 'escalated');

  const state = await founder.readConsole();
  const stored = state.briefs.find((x) => x.id === brief.brief_id);
  assert.deepEqual(stored.price_band, pricing.price_band);
  assert.deepEqual(stored.credentials_cited, [a.projects[0].id]);
  assert.deepEqual(stored.flags, ['human_review_required']);
  assert.ok(state.comparables.every((row) => Number.isInteger(row.n)));

  const approved = await founder.reviewBrief({ brief_id: brief.brief_id, decision: 'approved' });
  assert.equal(approved.outcome, 'approved');
  const blocked = await founder.reviewBrief({ brief_id: brief.brief_id, decision: 'approved' });
  assert.equal(blocked.outcome, 'blocked');
});

test('a rolled-back transaction leaves no partial state, and append-only triggers hold', async () => {
  const before = (await database.query('SELECT count(*)::int AS n FROM tender_desk.clients')).rows[0].n;
  await assert.rejects(database.transaction(async (tx) => {
    await tx.query("INSERT INTO tender_desk.clients (name,capabilities,categories,team_size,max_contract_cents) VALUES ('Ghost','x',ARRAY['other'],1,1)");
    throw new Error('abort');
  }), /abort/);
  assert.equal((await database.query('SELECT count(*)::int AS n FROM tender_desk.clients')).rows[0].n, before);
  await assert.rejects(database.query('DELETE FROM tender_desk.audit_log'), { code: '55000' });
});

test('founder actions persist: reveal state survives a new desk over the same database', async () => {
  assert.equal((await founder.revealBacktest({ tender_no: 'NEW-1' })).outcome, 'allowed');
  const again = createTenderDesk({ database, dataset, founderToken }).founder(founderToken);
  assert.equal((await again.readConsole()).backtest.revealed, 1);
});

test('TLS is configured explicitly from the URL so runtimes whose sockets hide the hostname still send SNI', () => {
  const seen = [];
  const fake = (url, options) => { seen.push(options); return {}; };
  connectPg(fake, 'postgresql://u:p@ep-abc-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require');
  assert.deepEqual(seen[0].ssl, { servername: 'ep-abc-pooler.ap-southeast-1.aws.neon.tech', rejectUnauthorized: true });
  connectPg(fake, 'postgres://u:p@127.0.0.1:5432/db');
  assert.equal(seen[1].ssl, undefined);
  connectPg(fake, 'postgres://u:p@host/db?sslmode=disable');
  assert.equal(seen[2].ssl, undefined);
  connectPg(fake, 'postgresql://u:p@ep-abc.neon.tech/neondb?sslmode=require', { ssl: false });
  assert.equal(seen[3].ssl, false);
});
