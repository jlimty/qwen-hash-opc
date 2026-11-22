import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { initializeGovernance } from '../src/governance-db.mjs';
import { createTenderDesk } from '../src/governance.mjs';
import { testUen } from './support/uen.mjs';
import { parseTenderCsv } from '../src/tender-data.mjs';

const header = 'tender_no,tender_description,agency,award_date,tender_detail_status,supplier_name,awarded_amt\n';
const dataset = parseTenderCsv(header + [1, 2, 3, 4, 5, 6].map((i) =>
  `OLD-${i},Event management services,Agency A,1/${i}/2025,Awarded to Suppliers,Past supplier,${i * 100000}.00`).join('\n'));
const adminToken = randomBytes(32).toString('hex');
let db; let desk; let admin; let operator;

before(async () => {
  db = await PGlite.create();
  await initializeGovernance(db);
  desk = createTenderDesk({ database: db, dataset, adminToken, agentRoles: ['operator'] });
  admin = desk.admin(adminToken);
  const issued = await admin.issueAgentCredential({ role: 'operator' });
  assert.equal(issued.outcome, 'allowed');
  operator = await desk.agent(issued.token);
});
after(async () => { await db?.close(); });

async function pendingBrief() {
  const userId = `user-${randomUUID().slice(0, 12)}`;
  const created = await desk.registerCustomer(userId, { uen: testUen(), name: `Wren Events ${randomUUID().slice(0, 6)}`, capabilities: 'Events', categories: ['events-community'],
    team_size: 5, max_contract_cents: 90000000, past_projects: [{ title: 'Event for a ministry', agency: 'Agency A' }] });
  await admin.verifyProject({ project_id: created.projects[0].id, verified: true, note: 'Checked.' });
  const tender_no = `LIVE${randomUUID().slice(0, 8).toUpperCase()}`;
  await db.query(`INSERT INTO tender_desk.open_tenders (tender_no,title,agency,closes_at,gebiz_url,source_feed,category)
    VALUES ($1,'Event management for a festival','Agency A','2026-12-04T05:00:00Z','https://www.gebiz.gov.sg/x','Event Organising','events-community')`, [tender_no]);
  const customer = await desk.customer(userId);
  const requested = await customer.requestBrief({ tender_no, terms: ['event management'] }, { now: new Date('2026-11-20T00:00:00Z') });
  const facts = await admin.prepareDraft(requested.request_id);
  const { checkDraft } = await import('../src/brief-drafting.mjs');
  const checked = checkDraft({ recommendation: 'bid', reasons: ['The work matches your ministry event.'],
    price_position: { band: 'lower_quartile_to_median', why: 'The scope is standard and the team is small, so stay near the middle.' },
    requirements: [], questions: [], risks: [], credentials_cited: [created.projects[0].id] }, facts);
  const saved = await admin.saveDraft({ request_id: requested.request_id, ...checked.draft });
  return { ...requested, brief_id: saved.brief_id, project_id: created.projects[0].id, client_id: created.client_id };
}

test('the operator sees only its own tools, none of which decide anything', () => {
  assert.deepEqual([...operator.toolNames].sort(), ['add_review_note', 'get_review_pack', 'list_queue', 'prepare_project_check', 'propose_revision']);
});

test('customer and intake connectors are refused when the site turns them off', async () => {
  const client = await admin.createClient({ name: `Old ${randomUUID().slice(0, 6)}`, capabilities: 'x', categories: ['other'], team_size: 1, max_contract_cents: 1, past_projects: [] });
  const key = await admin.issueAgentCredential({ role: 'client', client_id: client.client_id });
  await assert.rejects(desk.agent(key.token), /Unauthorized/);
});

test('list_queue shows pending briefs and waiting requests, soonest closing first', async () => {
  const brief = await pendingBrief();
  const queue = await operator.invoke('list_queue', {});
  assert.equal(queue.outcome, 'allowed');
  assert.ok(queue.pending_briefs.some((b) => b.brief_id === brief.brief_id && b.title === 'Event management for a festival'));
});

test('get_review_pack gathers the draft, the comparables with outliers flagged, and the client', async () => {
  const brief = await pendingBrief();
  const pack = await operator.invoke('get_review_pack', { brief_id: brief.brief_id });
  assert.equal(pack.outcome, 'allowed');
  assert.match(pack.brief.content, /## Recommendation/);
  assert.equal(pack.brief.parts.price_position.band, 'lower_quartile_to_median');
  assert.ok(pack.comparables.length >= 5);
  assert.ok(pack.comparables.every((c) => typeof c.far_from_median === 'boolean' && c.description));
  assert.equal(pack.client.verified_projects[0].title, 'Event for a ministry');
});

test('add_review_note stores a suggestion that the admin sees; it never changes the brief status', async () => {
  const brief = await pendingBrief();
  const noted = await operator.invoke('add_review_note', { subject: 'brief', id: brief.brief_id, note: 'Reasons are specific; range fits the comparables.', suggested_action: 'approve' });
  assert.equal(noted.outcome, 'allowed');
  const state = await admin.readConsole();
  assert.ok(state.notes.some((n) => n.subject_id === brief.brief_id && n.suggested_action === 'approve'));
  assert.equal(state.briefs.find((b) => b.id === brief.brief_id).status, 'pending_approval');
});

test('propose_revision replaces a pending draft only when it passes every check', async () => {
  const brief = await pendingBrief();
  const good = await operator.invoke('propose_revision', { brief_id: brief.brief_id, recommendation: 'bid', reasons: ['Your ministry event is the same kind of work.'],
    price_position: { band: 'median_to_upper_quartile', why: 'Your direct track record with this buyer justifies sitting above the middle.' }, questions: ['Is there a site visit?'], risks: [] });
  assert.equal(good.outcome, 'allowed', good.reason);
  const row = (await db.query('SELECT parts,status FROM tender_desk.briefs WHERE id=$1', [brief.brief_id])).rows[0];
  assert.equal(row.parts.price_position.band, 'median_to_upper_quartile');
  assert.equal(row.status, 'pending_approval');
  const bad = await operator.invoke('propose_revision', { brief_id: brief.brief_id, recommendation: 'bid', reasons: ['Similar work went for S$999,999.'],
    price_position: { band: 'median_to_upper_quartile', why: 'Your direct track record with this buyer justifies sitting above the middle.' }, questions: [], risks: [] });
  assert.equal(bad.outcome, 'blocked');
  assert.match(bad.reason, /figures|price/);
});

test('prepare_project_check runs the GeBIZ cross-check and leaves a note, not a verification', async () => {
  const brief = await pendingBrief();
  const unverified = (await db.query('INSERT INTO tender_desk.projects (client_id,title,verified) VALUES ($1,$2,false) RETURNING id', [brief.client_id, 'Gala dinner'])).rows[0];
  const checked = await operator.invoke('prepare_project_check', { project_id: unverified.id });
  assert.equal(checked.outcome, 'allowed');
  assert.ok(['match', 'mismatch', 'not_found', 'no_tender_number', 'hidden'].includes(checked.check_result) || typeof checked.check_result === 'string');
  assert.equal((await db.query('SELECT verified FROM tender_desk.projects WHERE id=$1', [unverified.id])).rows[0].verified, false);
  assert.ok((await admin.readConsole()).notes.some((n) => n.subject_id === unverified.id));
});

test('every operator tool has an input schema MCP can publish', async () => {
  const { z } = await import('zod');
  for (const tool of operator.tools) {
    const schema = z.toJSONSchema(tool.schema, { io: 'input', unrepresentable: 'throw' });
    assert.equal(schema.type, 'object', tool.name);
    assert.ok(tool.description.length > 20, tool.name);
  }
});

test('an approval names the revision the admin saw; a brief revised since then is refused', async () => {
  const brief = await pendingBrief();
  const seen = (await db.query('SELECT revision FROM tender_desk.briefs WHERE id=$1', [brief.brief_id])).rows[0].revision;
  await operator.invoke('propose_revision', { brief_id: brief.brief_id, recommendation: 'bid', reasons: ['Your ministry event is the same kind of work.'],
    price_position: { band: 'median_to_upper_quartile', why: 'Your direct track record with this buyer justifies sitting above the middle.' }, questions: [], risks: [] });
  const stale = await admin.reviewBrief({ brief_id: brief.brief_id, decision: 'approved', revision: seen });
  assert.equal(stale.outcome, 'blocked');
  assert.match(stale.reason, /changed since you opened it/);
  const notes = (await admin.readConsole()).notes.filter((n) => n.subject_id === brief.brief_id);
  assert.ok(!notes.some((n) => n.suggested_action === 'approve'), 'a revision does not mark itself approvable');
  const fresh = (await db.query('SELECT revision FROM tender_desk.briefs WHERE id=$1', [brief.brief_id])).rows[0].revision;
  assert.equal((await admin.reviewBrief({ brief_id: brief.brief_id, decision: 'approved', revision: fresh })).outcome, 'approved');
});

test('operator calls are recorded as the admin\'s QwenWork, never as the customer\'s agent, and every recorded action has a readable label', async () => {
  const brief = await pendingBrief();
  await operator.invoke('add_review_note', { subject: 'brief', id: brief.brief_id, note: 'Reads well.', suggested_action: 'approve' });
  const customer = (await db.query("SELECT user_id FROM tender_desk.customers WHERE client_id=$1", [brief.client_id])).rows[0];
  await (await desk.customer(customer.user_id)).buyCredits({ credits: 5 });
  const row = (await db.query("SELECT actor FROM tender_desk.audit_log WHERE action='add_review_note' ORDER BY ts DESC LIMIT 1")).rows[0];
  assert.match(row.actor, /^operator:/);
  const { actionLabels, actorName } = await import('../src/console-view.mjs');
  assert.equal(actorName({ actor: row.actor, client_id: brief.client_id }, () => 'Wren Events'), 'Your QwenWork');
  const actions = (await db.query('SELECT DISTINCT action FROM tender_desk.audit_log')).rows.map((r) => r.action);
  assert.deepEqual(actions.filter((action) => !actionLabels[action]), []);
});

test('the review pack lists the client\'s profile gaps, so a thin profile is caught before approval', async () => {
  const brief = await pendingBrief();
  const pack = await operator.invoke('get_review_pack', { brief_id: brief.brief_id });
  assert.equal(pack.outcome, 'allowed');
  assert.ok(Array.isArray(pack.profile_gaps));
  assert.ok(pack.profile_gaps.some((g) => g.code === 'thin_description'), JSON.stringify(pack.profile_gaps));
});

test('the operator can suggest asking the client for more, with what to ask', async () => {
  const brief = await pendingBrief();
  const noted = await operator.invoke('add_review_note', { subject: 'brief', id: brief.brief_id, note: 'No checked project is like this work.', suggested_action: 'ask_for_more' });
  assert.equal(noted.outcome, 'allowed', noted.reason);
});
