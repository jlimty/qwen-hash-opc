import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { initializeGovernance } from '../src/governance-db.mjs';
import { createTenderDesk } from '../src/governance.mjs';
import { parseTenderCsv } from '../src/tender-data.mjs';
import { connectorSlug } from '../src/connector-config.mjs';
import { namesOtherClient } from '../src/governance-agent.mjs';

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
const submitAs = async (context, agent, overrides = {}) => agent.invoke('submit_brief', brief(context, await price(context, agent), overrides));
const price = (context, agent = context.agentA) => agent.invoke('request_pricing', { tender_no: context.tender_no, query: 'event management' });
function brief(context, pricing, overrides = {}) {
  return { tender_no: context.tender_no, stat_id: pricing.stat_id, price_band: pricing.price_band,
    recommendation: 'bid', content: 'Assess staffing and delivery capacity before bidding.', credentials_cited: [], ...overrides };
}

test('audit keeps a live GeBIZ tender number that is not in the dataset', async () => {
  const result = await founder.revealBacktest({ tender_no: 'RPO000ETQ26000129' });
  assert.equal(result.outcome, 'blocked');
  const { rows } = await db.query('SELECT tender_no FROM tender_desk.audit_log ORDER BY id DESC LIMIT 1');
  assert.equal(rows[0].tender_no, 'RPO000ETQ26000129');
});

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

test('intake create_client returns a working connector bound to the new client', async () => {
  const intake = await desk.agent((await founder.issueAgentCredential({ role: 'intake' })).token);
  const name = `Cedar Markets ${randomUUID().slice(0, 8)}`;
  const created = await intake.invoke('create_client', profile(name));
  assert.equal(created.outcome, 'allowed');
  assert.match(created.client_reference, /^CLI\d{5,}$/);
  const server = created.connector_config.mcpServers[created.connector_name];
  assert.match(created.connector_name, /^tender-desk-cedar-markets-/);
  assert.deepEqual(Object.keys(server).sort(), ['headers', 'timeout', 'url']);
  assert.match(server.headers.Authorization, /^Bearer [a-f0-9]{64}$/);
  const agent = await desk.agent(server.headers.Authorization.slice(7));
  assert.equal((await agent.invoke('get_client_context', {})).client.name, name);
});

test('the connector token never reaches the audit log', async () => {
  const intake = await desk.agent((await founder.issueAgentCredential({ role: 'intake' })).token);
  const created = await intake.invoke('create_client', profile(`Token Audit ${randomUUID()}`));
  const token = created.connector_config.mcpServers[created.connector_name].headers.Authorization.slice(7);
  const { rows } = await db.query('SELECT * FROM tender_desk.audit_log');
  assert.doesNotMatch(JSON.stringify(rows), new RegExp(token));
  const row = rows.find((r) => r.action === 'create_client' && r.client_id === created.client_id);
  assert.equal(row.summary.client_reference, created.client_reference);
});

test('a GeBIZ tender number given at intake is stored on the project', async () => {
  const intake = await desk.agent((await founder.issueAgentCredential({ role: 'intake' })).token);
  const input = profile(`GeBIZ Intake ${randomUUID()}`);
  input.past_projects[0].gebiz_tender_no = 'OLD-1';
  const created = await intake.invoke('create_client', input);
  const { rows } = await db.query('SELECT gebiz_tender_no FROM tender_desk.projects WHERE client_id=$1', [created.client_id]);
  assert.equal(rows[0].gebiz_tender_no, 'OLD-1');
});

test('a duplicate company name gets a neutral message', async () => {
  const intake = await desk.agent((await founder.issueAgentCredential({ role: 'intake' })).token);
  const name = `Twin Events ${randomUUID()}`;
  await intake.invoke('create_client', profile(name));
  const again = await intake.invoke('create_client', profile(name.toUpperCase()));
  assert.equal(again.outcome, 'blocked');
  assert.equal(again.reason, 'That company name is not available. If this is your company, contact Tender Desk.');
});

test('connectorSlug makes a safe bounded name', () => {
  assert.equal(connectorSlug('Cedar Markets Pte. Ltd.'), 'tender-desk-cedar-markets-pte-ltd');
  assert.equal(connectorSlug('***'), 'tender-desk-client');
  assert.ok(connectorSlug('x'.repeat(200)).length <= 'tender-desk-'.length + 40);
});

test('the client sees an approved brief in its context', async () => {
  const c = await setup();
  const submitted = await submitAs(c, c.agentA, { content: 'Bid, subject to capacity.' });
  await founder.reviewBrief({ brief_id: submitted.brief_id, decision: 'approved' });
  const { client } = await c.agentA.invoke('get_client_context', {});
  const mine = client.briefs.find((b) => b.tender_no === c.tender_no);
  assert.match(mine.reference, /^BRF\d{5,}$/);
  assert.equal(mine.status, 'approved');
  assert.equal(mine.content, 'Bid, subject to capacity.');
  assert.ok(mine.decided_at);
});

test('the client sees the decline reason', async () => {
  const c = await setup();
  const submitted = await submitAs(c, c.agentA);
  await founder.reviewBrief({ brief_id: submitted.brief_id, decision: 'declined', reason: 'Scope is beyond the team size.' });
  const mine = (await c.agentA.invoke('get_client_context', {})).client.briefs[0];
  assert.equal(mine.status, 'declined');
  assert.equal(mine.decline_reason, 'Scope is beyond the team size.');
});

test('a decline without a reason is blocked', async () => {
  const c = await setup();
  const submitted = await submitAs(c, c.agentA);
  const result = await founder.reviewBrief({ brief_id: submitted.brief_id, decision: 'declined' });
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.reason, 'A decline needs a reason.');
});

test('an escalated client sees awaiting_admin, then not_advised', async () => {
  const c = await setup();
  await submitAs(c, c.agentA);
  const conflict = await submitAs(c, c.agentB);
  assert.deepEqual((await c.agentB.invoke('get_client_context', {})).client.advice_refused, [{ tender_no: c.tender_no, status: 'awaiting_admin' }]);
  await founder.resolveConflict({ conflict_id: conflict.conflict_id, resolution: 'serve_holder' });
  assert.deepEqual((await c.agentB.invoke('get_client_context', {})).client.advice_refused, [{ tender_no: c.tender_no, status: 'not_advised' }]);
});

test('client context never leaks the holder, risk or another client', async () => {
  const c = await setup();
  await submitAs(c, c.agentA);
  await submitAs(c, c.agentB);
  const text = JSON.stringify(await c.agentB.invoke('get_client_context', {}));
  assert.doesNotMatch(text, /holder_client_id|risk_level|risk_facts|flags/);
  assert.doesNotMatch(text, new RegExp(c.a.client_id));
  const { rows } = await db.query('SELECT name FROM tender_desk.clients WHERE id=$1', [c.a.client_id]);
  assert.doesNotMatch(text, new RegExp(rows[0].name));
});

test('verifying a project without a GeBIZ match needs a note', async () => {
  const c = await setup();
  const result = await founder.verifyProject({ project_id: c.a.projects[0].id, verified: true });
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.rule_id, 'G3');
  assert.equal(result.reason, 'A note is required to verify a project without a GeBIZ match.');
});

test('verifying with a note stores the note and time, and unverifying clears the time', async () => {
  const c = await setup();
  const id = c.a.projects[0].id;
  assert.equal((await founder.verifyProject({ project_id: id, verified: true, note: 'Saw the signed contract.' })).outcome, 'allowed');
  let row = (await db.query('SELECT verified, verification_note, verified_at FROM tender_desk.projects WHERE id=$1', [id])).rows[0];
  assert.deepEqual([row.verified, row.verification_note, Boolean(row.verified_at)], [true, 'Saw the signed contract.', true]);
  const audit = (await db.query("SELECT summary FROM tender_desk.audit_log WHERE action='verify_project' ORDER BY id DESC LIMIT 1")).rows[0].summary;
  assert.deepEqual([audit.check_result, audit.note], ['no_match', 'Saw the signed contract.']);
  assert.match(audit.project_reference, /^PRJ\d{5,}$/);
  await founder.verifyProject({ project_id: id, verified: false });
  row = (await db.query('SELECT verified, verified_at FROM tender_desk.projects WHERE id=$1', [id])).rows[0];
  assert.deepEqual([row.verified, row.verified_at], [false, null]);
});

test('a GeBIZ match verifies without a note', async () => {
  const created = await founder.createClient({ ...profile(`Historical Supplier`), past_projects: [{ title: 'Past event', gebiz_tender_no: 'OLD-1' }] });
  assert.equal((await founder.verifyProject({ project_id: created.projects[0].id, verified: true })).outcome, 'allowed');
});

test('the holder sees not_advised when the admin stops advising on its tender', async () => {
  const c = await setup();
  const mine = await submitAs(c, c.agentA);
  const conflict = await submitAs(c, c.agentB);
  await founder.resolveConflict({ conflict_id: conflict.conflict_id, resolution: 'serve_neither' });
  const context = (await c.agentA.invoke('get_client_context', {})).client;
  assert.deepEqual(context.advice_refused, [{ tender_no: c.tender_no, status: 'not_advised' }]);
  assert.equal(context.briefs.find((b) => b.reference && b.tender_no === c.tender_no).status, 'pending_approval');
  assert.ok(mine.brief_id);
  assert.deepEqual((await c.agentB.invoke('get_client_context', {})).client.advice_refused, [{ tender_no: c.tender_no, status: 'not_advised' }]);
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

test('two clients can both get the band for one tender', async () => {
  const c = await setup();
  const [a, b] = await Promise.all([price(c), price(c, c.agentB)]);
  assert.equal(a.outcome, 'allowed');
  assert.equal(b.outcome, 'allowed');
  assert.deepEqual(a.price_band, { low_cents: 20000, median_cents: 30000, high_cents: 40000 });
  assert.deepEqual(b.price_band, a.price_band);
  assert.equal((await db.query('SELECT * FROM tender_desk.pricing_holds WHERE tender_no=$1', [c.tender_no])).rows.length, 0);
});

test('competing briefs produce one holder and one private escalation that saves nothing', async () => {
  const c = await setup();
  const [pa, pb] = await Promise.all([price(c), price(c, c.agentB)]);
  const results = await Promise.all([c.agentA.invoke('submit_brief', brief(c, pa)), c.agentB.invoke('submit_brief', brief(c, pb))]);
  const allowed = results.filter((r) => r.outcome === 'allowed');
  const escalated = results.filter((r) => r.outcome === 'escalated');
  assert.equal(allowed.length, 1);
  assert.equal(escalated.length, 1);
  assert.equal(escalated[0].rule_id, 'G2');
  assert.equal(escalated[0].reason, 'Tender Desk already advises another client on this tender. The admin has been notified. No advice can be given to you on it.');
  assert.doesNotMatch(JSON.stringify(escalated[0]), /stat_id|price_band|low_cents|Amber|Birch|client_id/);
  assert.equal((await db.query('SELECT * FROM tender_desk.pricing_holds WHERE tender_no=$1', [c.tender_no])).rows.length, 1);
  assert.equal((await db.query('SELECT * FROM tender_desk.briefs WHERE tender_no=$1', [c.tender_no])).rows.length, 1);
  assert.equal((await db.query("SELECT * FROM tender_desk.conflicts WHERE tender_no=$1 AND status='open'", [c.tender_no])).rows.length, 1);
});

test('a blocked brief takes no hold', async () => {
  const c = await setup();
  assert.equal((await submitAs(c, c.agentA, { credentials_cited: [c.a.projects[0].id] })).rule_id, 'G3');
  assert.equal((await submitAs(c, c.agentB)).status, 'pending_approval');
  const { rows } = await db.query('SELECT client_id FROM tender_desk.pricing_holds WHERE tender_no=$1', [c.tender_no]);
  assert.equal(rows[0].client_id, c.b.client_id);
});

test('holder resubmits after decline without escalating against itself', async () => {
  const c = await setup();
  const first = await submitAs(c, c.agentA);
  await founder.reviewBrief({ brief_id: first.brief_id, decision: 'declined', reason: 'Tighten the risks section.' });
  const again = await submitAs(c, c.agentA);
  assert.equal(again.status, 'pending_approval');
  assert.equal((await db.query('SELECT * FROM tender_desk.conflicts WHERE tender_no=$1', [c.tender_no])).rows.length, 0);
});

test('G1 matches another client name as whole words only', async () => {
  const c = await setup();
  const name = `Birch Events ${randomUUID().slice(0, 8)}`;
  await founder.createClient({ ...profile(name), past_projects: [] });
  assert.equal((await submitAs(c, c.agentA, { content: `${name}ful planning ahead.` })).outcome, 'allowed');
  const leak = await submitAs(c, c.agentA, { content: `We met ${name.toLowerCase()} last year.` });
  assert.equal(leak.outcome, 'blocked');
  assert.equal(leak.rule_id, 'G1');
});

test('G1 tolerates regex characters in client names', async () => {
  const c = await setup();
  const name = `A+B Events (Pte.) Ltd ${randomUUID().slice(0, 4)}`;
  await founder.createClient({ ...profile(name), past_projects: [] });
  assert.equal(namesOtherClient(`Partner: ${name}.`, [name]), true);
  assert.equal(namesOtherClient('A Events Pte Ltd', [name]), false);
  assert.equal((await submitAs(c, c.agentA, { content: `Partner: ${name}.` })).rule_id, 'G1');
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
  await submitAs(c, c.agentA);
  const conflict = await submitAs(c, c.agentB);
  await founder.resolveConflict({ conflict_id: conflict.conflict_id, resolution: 'serve_holder' });
  const again = await submitAs(c, c.agentB);
  assert.equal(again.outcome, 'escalated');
  const { rows } = await db.query('SELECT status,resolution FROM tender_desk.conflicts WHERE id=$1', [conflict.conflict_id]);
  assert.deepEqual(rows[0], { status: 'resolved', resolution: 'serve_holder' });
});

test('briefs may cite no projects, and a repeated verified project ID is still verified', async () => {
  const c = await setup();
  const pricing = await price(c);
  const none = await c.agentA.invoke('submit_brief', brief(c, pricing, { recommendation: 'no-bid', credentials_cited: [] }));
  assert.equal(none.outcome, 'allowed');
  await founder.verifyProject({ project_id: c.a.projects[0].id, verified: true, note: 'Checked by the admin (test).' });
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
  assert.equal((await db.query('SELECT * FROM tender_desk.pricing_holds WHERE tender_no=$1', [c.tender_no])).rows.length, 0);
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
  assert.equal(other.rule_id, 'G4');
  assert.equal((await db.query('SELECT * FROM tender_desk.briefs WHERE tender_no=$1', [c.tender_no])).rows.length, 0);
});

test('snapshot and verified-project identities cannot be reused for a different client or tender', async () => {
  const c = await setup();
  const pricing = await price(c);
  await founder.verifyProject({ project_id: c.b.projects[0].id, verified: true, note: 'Checked by the admin (test).' });
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
  assert.deepEqual(Object.keys(flagged).filter((key) => /risk|flags/.test(key)), []);
  const { rows: stored } = await db.query('SELECT risk_facts, risk_level FROM tender_desk.briefs WHERE id=$1', [flagged.brief_id]);
  assert.ok(stored[0].risk_facts.some((f) => f.code === 'unmatched_numbers' && /999,999\.00, 95%/.test(f.message)));
  assert.equal(stored[0].risk_level, 'high');
});

test('only founder verification and approval release a valid pending brief', async () => {
  const c = await setup();
  const pricing = await price(c);
  await founder.verifyProject({ project_id: c.a.projects[0].id, verified: true, note: 'Checked by the admin (test).' });
  assert.equal((await c.agentA.invoke('get_client_context', {})).client.past_projects.length, 1);
  const submitted = await c.agentA.invoke('submit_brief', brief(c, pricing, { credentials_cited: [c.a.projects[0].id] }));
  assert.equal(submitted.status, 'pending_approval');
  assert.equal((await c.agentA.invoke('approve_brief', { brief_id: submitted.brief_id })).outcome, 'blocked');
  const approved = await founder.reviewBrief({ brief_id: submitted.brief_id, decision: 'approved' });
  assert.equal(approved.outcome, 'approved');
  assert.equal((await founder.reviewBrief({ brief_id: submitted.brief_id, decision: 'declined', reason: 'Too late.' })).outcome, 'blocked');
});

test('approval rechecks a project that was revoked after the brief was submitted', async () => {
  const c = await setup();
  const pricing = await price(c);
  await founder.verifyProject({ project_id: c.a.projects[0].id, verified: true, note: 'Checked by the admin (test).' });
  const submitted = await c.agentA.invoke('submit_brief', brief(c, pricing, { credentials_cited: [c.a.projects[0].id] }));
  await founder.verifyProject({ project_id: c.a.projects[0].id, verified: false });
  assert.equal((await founder.reviewBrief({ brief_id: submitted.brief_id, decision: 'approved' })).rule_id, 'G3');
});

test('founder may stop further pricing but cannot transfer advice already disclosed', async () => {
  const c = await setup();
  const pricing = await price(c);
  const pending = await c.agentA.invoke('submit_brief', brief(c, pricing));
  const conflict = await submitAs(c, c.agentB);
  const transfer = await founder.resolveConflict({ conflict_id: conflict.conflict_id, resolution: 'serve_challenger' });
  assert.equal(transfer.outcome, 'blocked');
  assert.equal((await founder.resolveConflict({ conflict_id: conflict.conflict_id, resolution: 'serve_neither' })).outcome, 'allowed');
  assert.equal((await price(c)).outcome, 'allowed');
  const stopped = await submitAs(c, c.agentA);
  assert.equal(stopped.rule_id, 'G2');
  assert.equal(stopped.reason, 'Tender Desk has stopped advising on this tender.');
  assert.equal((await submitAs(c, c.agentB)).rule_id, 'G2');
  assert.equal((await founder.reviewBrief({ brief_id: pending.brief_id, decision: 'approved' })).rule_id, 'G2');
});

test('serving the existing holder never gives the competing client access', async () => {
  const c = await setup();
  await submitAs(c, c.agentA);
  const conflict = await submitAs(c, c.agentB);
  assert.equal((await founder.resolveConflict({ conflict_id: conflict.conflict_id, resolution: 'serve_holder' })).outcome, 'allowed');
  assert.equal((await submitAs(c, c.agentA)).outcome, 'allowed');
  assert.equal((await submitAs(c, c.agentB)).outcome, 'escalated');
});

test('audit records allowed, blocked and escalated actions without raw client inputs', async () => {
  const c = await setup();
  await c.agentA.invoke('get_client_context', { client_id: c.b.client_id, token: 'sensitive-input-marker' });
  await submitAs(c, c.agentA);
  await submitAs(c, c.agentB);
  const { rows } = await db.query('SELECT * FROM tender_desk.audit_log WHERE client_id=$1 OR client_id=$2 ORDER BY id', [c.a.client_id, c.b.client_id]);
  assert.ok(rows.some((r) => r.outcome === 'allowed' && r.action === 'request_pricing'));
  assert.ok(rows.some((r) => r.outcome === 'blocked' && r.rule_id === 'G1'));
  assert.ok(rows.some((r) => r.outcome === 'escalated' && r.rule_id === 'G2'));
  assert.doesNotMatch(JSON.stringify(rows), /sensitive-input-marker/);
});
