import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { initializeGovernance } from '../src/governance-db.mjs';
import { createTenderDesk } from '../src/governance.mjs';
import { parseTenderCsv } from '../src/tender-data.mjs';

const header = 'tender_no,tender_description,agency,award_date,tender_detail_status,supplier_name,awarded_amt\n';
const dataset = parseTenderCsv(header + [
  ...[1, 2, 3, 4, 5].map((i) => `OLD-${i},Event management services,Agency A,1/${i}/2025,Awarded to Suppliers,Historical supplier,${i * 100}`),
  ...Array.from({ length: 40 }, (_, i) => `NEW-${i + 1},Event management services,Agency A,1/1/2026,Awarded to Suppliers,Hidden winner,9876543`),
].join('\n'));
const founderToken = randomBytes(32).toString('hex');
let db;
let desk;
let founder;
let sequence = 0;

before(async () => {
  db = await PGlite.create();
  await initializeGovernance(db);
  desk = createTenderDesk({ database: db, dataset, founderToken });
  founder = desk.founder(founderToken);
});
after(async () => { await db?.close(); });

const profile = (name) => ({ name, capabilities: 'Event production', categories: ['events-community'], team_size: 8,
  max_contract_cents: 50000000, past_projects: [{ title: 'Community festival', agency: 'Agency A', value_cents: 100000 }] });
async function setup() {
  const suffix = randomUUID().slice(0, 8);
  const a = await founder.createClient(profile(`Amber Events ${suffix}`));
  const b = await founder.createClient(profile(`Birch Events ${suffix}`));
  const keyA = await founder.issueAgentCredential({ role: 'client', client_id: a.client_id });
  const keyB = await founder.issueAgentCredential({ role: 'client', client_id: b.client_id });
  return { a, b, keyA, keyB, agentA: await desk.agent(keyA.token), agentB: await desk.agent(keyB.token), tender_no: `NEW-${++sequence}` };
}
const price = (context, agent = context.agentA) => agent.invoke('request_pricing', { tender_no: context.tender_no, query: 'event management' });
function brief(context, pricing, overrides = {}) {
  return { tender_no: context.tender_no, stat_id: pricing.stat_id, price_band: pricing.price_band,
    recommendation: 'bid', content: 'Assess staffing and delivery capacity before bidding.', credentials_cited: [], ...overrides };
}

test('client identity comes from the credential, never a caller-selected client_id', async () => {
  const c = await setup();
  const result = await c.agentA.invoke('get_client_context', {});
  assert.equal(result.outcome, 'allowed');
  assert.equal(result.client.id, c.a.client_id);
  assert.deepEqual(result.client.past_projects, []);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(c.b.client_id));
  const spoof = await c.agentA.invoke('get_client_context', { client_id: c.b.client_id });
  assert.equal(spoof.outcome, 'blocked');
  assert.equal(spoof.rule_id, 'G1');
  assert.doesNotMatch(JSON.stringify(spoof), new RegExp(c.b.client_id));
});

test('credentials are stored only as hashes and revoked sessions lose access', async () => {
  const c = await setup();
  const stored = await db.query('SELECT token_hash FROM tender_desk.agent_credentials WHERE id=$1', [c.keyA.credential_id]);
  assert.equal(stored.rows[0].token_hash, createHash('sha256').update(c.keyA.token).digest('hex'));
  await assert.rejects(desk.agent('wrong'), /Unauthorized/);
  await assert.rejects(desk.agent(founderToken), /Unauthorized/);
  assert.throws(() => desk.founder(c.keyA.token), /Unauthorized/);
  await founder.revokeAgentCredential({ credential_id: c.keyA.credential_id });
  await assert.rejects(c.agentA.invoke('get_client_context', {}), /Unauthorized/);
  const audit = (await founder.readConsole()).audit;
  assert.doesNotMatch(JSON.stringify(audit), new RegExp(`${c.keyA.token}|${c.keyB.token}|${founderToken}`));
});

test('intake can create a client but cannot verify projects or access client work', async () => {
  const { token } = await founder.issueAgentCredential({ role: 'intake' });
  const intake = await desk.agent(token);
  const created = await intake.invoke('create_client', profile(`New Intake ${randomUUID()}`));
  assert.equal(created.outcome, 'allowed');
  assert.equal(created.projects[0].verified, false);
  const forged = profile(`Forged Intake ${randomUUID()}`);
  forged.past_projects[0].verified = true;
  const denied = await intake.invoke('create_client', forged);
  assert.equal(denied.outcome, 'blocked');
  assert.equal(denied.rule_id, 'G3');
  assert.equal((await intake.invoke('get_client_context', {})).outcome, 'blocked');
  assert.equal((await intake.invoke('request_pricing', { tender_no: 'NEW-1' })).outcome, 'blocked');
});

test('agent catalogs contain neither founder tools nor an ungated pricing path', async () => {
  const c = await setup();
  assert.equal(c.agentA.toolNames.includes('request_pricing'), true);
  for (const name of ['approve_brief', 'verify_project', 'resolve_conflict', 'reveal_outcome', 'market_stats', 'list_clients']) {
    assert.equal(c.agentA.toolNames.includes(name), false);
    assert.equal((await c.agentA.invoke(name, {})).outcome, 'blocked');
  }
  const historical = await c.agentA.invoke('search_tenders', { query: 'event' });
  assert.equal(historical.total, 5);
  assert.doesNotMatch(JSON.stringify(historical), /awarded|supplier|price|cents|Hidden winner|9876543/);
  assert.equal((await c.agentA.invoke('search_tenders', { min_amt: 100 })).outcome, 'blocked');
  const incoming = await c.agentA.invoke('get_incoming_tenders', { limit: 2 });
  assert.equal(incoming.items.length, 2);
  assert.doesNotMatch(JSON.stringify(incoming), /awarded|supplier|price|cents|Hidden winner|9876543/);
  assert.equal((await c.agentA.invoke('get_policies', {})).policies.length, 6);
});

test('shortlists are client-scoped and accept incoming metadata only', async () => {
  const c = await setup();
  const saved = await c.agentA.invoke('save_shortlist', { items: [{ tender_no: c.tender_no, fit_score: 80, reasons: ['Relevant capability'] }] });
  assert.equal(saved.outcome, 'allowed');
  assert.equal((await c.agentA.invoke('get_client_context', {})).client.shortlist.length, 1);
  assert.deepEqual((await c.agentB.invoke('get_client_context', {})).client.shortlist, []);
  const invalid = await c.agentA.invoke('save_shortlist', { items: [
    { tender_no: c.tender_no, fit_score: 60, reasons: ['Changed'] },
    { tender_no: 'OLD-1', fit_score: 70, reasons: ['Not incoming'] },
  ] });
  assert.equal(invalid.outcome, 'blocked');
  assert.equal((await c.agentA.invoke('get_client_context', {})).client.shortlist[0].fit_score, 80);
});

test('competing pricing requests produce one holder and one private escalation', async () => {
  const c = await setup();
  const results = await Promise.all([price(c), price(c, c.agentB)]);
  const allowed = results.filter((r) => r.outcome === 'allowed');
  const escalated = results.filter((r) => r.outcome === 'escalated');
  assert.equal(allowed.length, 1);
  assert.equal(escalated.length, 1);
  assert.equal(escalated[0].rule_id, 'G2');
  assert.deepEqual(allowed[0].price_band, { low_cents: 20000, median_cents: 30000, high_cents: 40000 });
  assert.doesNotMatch(JSON.stringify(escalated[0]), /stat_id|price_band|low_cents|Amber|Birch|client_id/);
  assert.equal((await db.query('SELECT * FROM tender_desk.pricing_holds WHERE tender_no=$1', [c.tender_no])).rows.length, 1);
  assert.equal((await db.query('SELECT * FROM tender_desk.stats_snapshots WHERE tender_no=$1', [c.tender_no])).rows.length, 1);
});

test('pricing responses expose the price band but no per-contract amounts or supplier identities', async () => {
  const c = await setup();
  const result = await c.agentA.invoke('request_pricing', { tender_no: c.tender_no, query: 'event management', same_agency: true });
  assert.equal(result.outcome, 'allowed');
  assert.equal(result.n, 5);
  assert.doesNotMatch(JSON.stringify(result), /comparables|top_suppliers|top_agencies|likely_incumbent|Historical supplier|total_awarded_cents|source_records/);
  const stored = (await db.query('SELECT snapshot FROM tender_desk.stats_snapshots WHERE tender_no=$1', [c.tender_no])).rows[0].snapshot;
  assert.equal(stored.comparables.length, 5);
});

test('NUL characters are rejected as audited validation blocks without side effects', async () => {
  const c = await setup();
  const before = (await db.query('SELECT count(*)::int AS n FROM tender_desk.audit_log')).rows[0].n;
  const pricing = await c.agentA.invoke('request_pricing', { tender_no: c.tender_no, query: 'event\u0000' });
  assert.equal(pricing.outcome, 'blocked');
  assert.equal(pricing.rule_id, 'VALIDATION');
  const intake = await desk.agent((await founder.issueAgentCredential({ role: 'intake' })).token);
  assert.equal((await intake.invoke('create_client', profile('Nul\u0000 Client'))).rule_id, 'VALIDATION');
  assert.equal((await c.agentA.invoke('save_shortlist', { items: [{ tender_no: c.tender_no, fit_score: 1, reasons: ['a\u0000b'] }] })).rule_id, 'VALIDATION');
  assert.equal((await db.query('SELECT * FROM tender_desk.pricing_holds WHERE tender_no=$1', [c.tender_no])).rows.length, 0);
  const after = (await db.query('SELECT count(*)::int AS n FROM tender_desk.audit_log')).rows[0].n;
  assert.ok(after - before >= 3);
});

test('a founder-resolved conflict stays resolved when the challenger asks again', async () => {
  const c = await setup();
  await price(c);
  const conflict = await price(c, c.agentB);
  await founder.resolveConflict({ conflict_id: conflict.conflict_id, resolution: 'serve_holder' });
  const again = await price(c, c.agentB);
  assert.equal(again.outcome, 'escalated');
  const { rows } = await db.query('SELECT status,resolution FROM tender_desk.conflicts WHERE id=$1', [conflict.conflict_id]);
  assert.deepEqual(rows[0], { status: 'resolved', resolution: 'serve_holder' });
});

test('briefs may cite no projects, and a repeated verified project ID is still verified', async () => {
  const c = await setup();
  const pricing = await price(c);
  const none = await c.agentA.invoke('submit_brief', brief(c, pricing, { recommendation: 'no-bid', credentials_cited: [] }));
  assert.equal(none.outcome, 'allowed');
  await founder.verifyProject({ project_id: c.a.projects[0].id, verified: true });
  const id = c.a.projects[0].id;
  const duplicate = await c.agentA.invoke('submit_brief', brief(c, pricing, { credentials_cited: [id, id] }));
  assert.equal(duplicate.outcome, 'allowed');
});

test('insufficient comparables create no exclusivity hold or price snapshot', async () => {
  const c = await setup();
  const denied = await c.agentA.invoke('request_pricing', { tender_no: c.tender_no, query: 'unmatchedword' });
  assert.equal(denied.rule_id, 'G4');
  assert.equal(denied.outcome, 'blocked');
  assert.equal((await db.query('SELECT * FROM tender_desk.pricing_holds WHERE tender_no=$1', [c.tender_no])).rows.length, 0);
  assert.equal((await price(c, c.agentB)).outcome, 'allowed');
  const attempt = await c.agentA.invoke('request_pricing', { tender_no: c.tender_no, query: 'unmatchedword' });
  assert.equal(attempt.rule_id, 'G2');
  assert.equal(attempt.outcome, 'escalated');
});

test('a holder can repeat pricing without duplicating the immutable snapshot', async () => {
  const c = await setup();
  const a = await price(c);
  const b = await price(c);
  assert.equal(a.stat_id, b.stat_id);
  assert.equal((await db.query('SELECT * FROM tender_desk.stats_snapshots WHERE tender_no=$1', [c.tender_no])).rows.length, 1);
  assert.equal((await c.agentA.invoke('request_pricing', { tender_no: 'OLD-1' })).outcome, 'blocked');
});

test('briefs reject unverified credentials, forged snapshots and altered price bands', async () => {
  const c = await setup();
  const pricing = await price(c);
  const unverified = await c.agentA.invoke('submit_brief', brief(c, pricing, { credentials_cited: [c.a.projects[0].id] }));
  assert.equal(unverified.rule_id, 'G3');
  const fake = await c.agentA.invoke('submit_brief', brief(c, pricing, { stat_id: `stat_${'0'.repeat(64)}` }));
  assert.equal(fake.rule_id, 'G4');
  const altered = await c.agentA.invoke('submit_brief', brief(c, pricing, { price_band: { ...pricing.price_band, low_cents: 1 } }));
  assert.equal(altered.rule_id, 'G4');
  const other = await c.agentB.invoke('submit_brief', brief(c, pricing));
  assert.equal(other.rule_id, 'G2');
  assert.equal((await db.query('SELECT * FROM tender_desk.briefs WHERE tender_no=$1', [c.tender_no])).rows.length, 0);
});

test('snapshot and verified-project identities cannot be reused for a different client or tender', async () => {
  const c = await setup();
  const pricing = await price(c);
  await founder.verifyProject({ project_id: c.b.projects[0].id, verified: true });
  assert.equal((await c.agentA.invoke('submit_brief', brief(c, pricing, { credentials_cited: [c.b.projects[0].id] }))).rule_id, 'G3');
  const another = `NEW-${++sequence}`;
  await c.agentA.invoke('request_pricing', { tender_no: another, query: 'management', same_agency: true });
  assert.equal((await c.agentA.invoke('submit_brief', brief(c, pricing, { tender_no: another }))).rule_id, 'G4');
});

test('briefs naming another client are blocked and uncited prose numbers are flagged', async () => {
  const c = await setup();
  const pricing = await price(c);
  const { rows } = await db.query('SELECT name FROM tender_desk.clients WHERE id=$1', [c.b.client_id]);
  const leak = await c.agentA.invoke('submit_brief', brief(c, pricing, { content: `Coordinate with ${rows[0].name.toUpperCase()}.` }));
  assert.equal(leak.rule_id, 'G1');
  const flagged = await c.agentA.invoke('submit_brief', brief(c, pricing, { content: 'Expected amount SGD 999,999.00 with 95% confidence.' }));
  assert.equal(flagged.outcome, 'allowed');
  assert.equal(flagged.status, 'pending_approval');
  assert.equal(flagged.flags.includes('unverified_numeric_content'), true);
});

test('only founder verification and approval release a valid pending brief', async () => {
  const c = await setup();
  const pricing = await price(c);
  await founder.verifyProject({ project_id: c.a.projects[0].id, verified: true });
  assert.equal((await c.agentA.invoke('get_client_context', {})).client.past_projects.length, 1);
  const submitted = await c.agentA.invoke('submit_brief', brief(c, pricing, { credentials_cited: [c.a.projects[0].id] }));
  assert.equal(submitted.status, 'pending_approval');
  assert.equal((await c.agentA.invoke('approve_brief', { brief_id: submitted.brief_id })).outcome, 'blocked');
  const approved = await founder.reviewBrief({ brief_id: submitted.brief_id, decision: 'approved' });
  assert.equal(approved.outcome, 'approved');
  assert.equal((await founder.reviewBrief({ brief_id: submitted.brief_id, decision: 'declined' })).outcome, 'blocked');
});

test('approval rechecks a project that was revoked after the brief was submitted', async () => {
  const c = await setup();
  const pricing = await price(c);
  await founder.verifyProject({ project_id: c.a.projects[0].id, verified: true });
  const submitted = await c.agentA.invoke('submit_brief', brief(c, pricing, { credentials_cited: [c.a.projects[0].id] }));
  await founder.verifyProject({ project_id: c.a.projects[0].id, verified: false });
  assert.equal((await founder.reviewBrief({ brief_id: submitted.brief_id, decision: 'approved' })).rule_id, 'G3');
});

test('founder may stop further pricing but cannot transfer advice already disclosed', async () => {
  const c = await setup();
  const pricing = await price(c);
  const pending = await c.agentA.invoke('submit_brief', brief(c, pricing));
  const conflict = await price(c, c.agentB);
  const transfer = await founder.resolveConflict({ conflict_id: conflict.conflict_id, resolution: 'serve_challenger' });
  assert.equal(transfer.outcome, 'blocked');
  assert.equal((await founder.resolveConflict({ conflict_id: conflict.conflict_id, resolution: 'serve_neither' })).outcome, 'allowed');
  assert.equal((await price(c)).rule_id, 'G2');
  assert.equal((await price(c, c.agentB)).rule_id, 'G2');
  assert.equal((await founder.reviewBrief({ brief_id: pending.brief_id, decision: 'approved' })).rule_id, 'G2');
});

test('serving the existing holder never gives the competing client access', async () => {
  const c = await setup();
  await price(c);
  const conflict = await price(c, c.agentB);
  assert.equal((await founder.resolveConflict({ conflict_id: conflict.conflict_id, resolution: 'serve_holder' })).outcome, 'allowed');
  assert.equal((await price(c)).outcome, 'allowed');
  assert.equal((await price(c, c.agentB)).outcome, 'escalated');
});

test('audit records allowed, blocked and escalated actions without raw client inputs', async () => {
  const c = await setup();
  await c.agentA.invoke('get_client_context', { client_id: c.b.client_id, token: 'sensitive-input-marker' });
  await price(c);
  await price(c, c.agentB);
  const { rows } = await db.query('SELECT * FROM tender_desk.audit_log WHERE client_id=$1 OR client_id=$2 ORDER BY id', [c.a.client_id, c.b.client_id]);
  assert.ok(rows.some((r) => r.outcome === 'allowed' && r.action === 'request_pricing'));
  assert.ok(rows.some((r) => r.outcome === 'blocked' && r.rule_id === 'G1'));
  assert.ok(rows.some((r) => r.outcome === 'escalated' && r.rule_id === 'G2'));
  assert.doesNotMatch(JSON.stringify(rows), /sensitive-input-marker/);
});
