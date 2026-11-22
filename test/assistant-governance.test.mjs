import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { initializeGovernance } from '../src/governance-db.mjs';
import { createTenderDesk } from '../src/governance.mjs';
import { parseTenderCsv } from '../src/tender-data.mjs';

const header = 'tender_no,tender_description,agency,award_date,tender_detail_status,supplier_name,awarded_amt\n';
const dataset = parseTenderCsv(header + [1, 2, 3, 4, 5, 6].map((i) =>
  `OLD-${i},Event management services,Agency A,1/${i}/2025,Awarded to Suppliers,Past supplier,${i * 100000}.00`).join('\n'));
const adminToken = randomBytes(32).toString('hex');
const now = new Date('2026-11-22T02:00:00Z');
const refusal = 'Tender Desk already advises a client on this tender.';
let db; let desk; let admin;

before(async () => {
  db = await PGlite.create();
  await initializeGovernance(db);
  desk = createTenderDesk({ database: db, dataset, adminToken });
  admin = desk.admin(adminToken);
});
after(async () => { await db?.close(); });

const profile = (name) => ({ name, capabilities: 'Event production', categories: ['events-community'], team_size: 8, max_contract_cents: 50000000,
  past_projects: [{ title: 'Annual event for a ministry', agency: 'Agency A', value_cents: 200000 }, { title: 'Unchecked gala' }] });

async function customer(label) {
  const userId = `user-${randomUUID().slice(0, 12)}`;
  const name = `${label} Events ${randomUUID().slice(0, 6)}`;
  const created = await desk.registerCustomer(userId, profile(name));
  assert.equal(created.outcome, 'allowed');
  await admin.verifyProject({ project_id: created.projects[0].id, verified: true, note: 'Checked.' });
  return { userId, name, client_id: created.client_id, projects: created.projects, ops: await desk.customer(userId) };
}

async function openTender({ closes = '2026-12-04T13:00:00+08:00' } = {}) {
  const tender_no = `LIVE${randomUUID().slice(0, 8).toUpperCase()}`;
  await db.query(`INSERT INTO tender_desk.open_tenders (tender_no,title,agency,published_on,closes_at,gebiz_url,source_feed,category)
    VALUES ($1,'Event management for a community festival','Agency A','2026-11-20',$2,'https://www.gebiz.gov.sg/ptn/x','Event Organising','events-community')`,
  [tender_no, closes]);
  return tender_no;
}
const ask = (who, tender_no) => who.ops.requestBrief({ tender_no, terms: ['event management'] }, { now });
const payments = async (client_id) => (await db.query(`SELECT p.* FROM tender_desk.payments p JOIN tender_desk.brief_requests r ON r.id=p.request_id
  WHERE r.client_id=$1`, [client_id])).rows;
const draft = (prepared, overrides = {}) => ({ recommendation: 'bid', content: 'Bid: the scope fits the team.',
  credentials_cited: prepared.verifiedProjects.map((project) => project.id), ...overrides });

test('registerCustomer links a Neon user to one client, once', async () => {
  const a = await customer('Aster');
  const again = await desk.registerCustomer(a.userId, profile(`Other ${randomUUID().slice(0, 6)}`));
  assert.equal(again.outcome, 'blocked');
  assert.equal(again.rule_id, 'G1');
  const context = await a.ops.context();
  assert.equal(context.client.name, a.name);
  assert.deepEqual(context.projects.map((project) => project.verified), [true, false]);
});

test('customer() rejects an unknown user', async () => {
  await assert.rejects(desk.customer('user-unknown-0001'), /Unauthorized/);
});

test('requestBrief takes the hold and records a test payment of 9900', async () => {
  const a = await customer('Birch');
  const tender_no = await openTender();
  assert.deepEqual(await a.ops.canRequest(tender_no, { now }), { ok: true });
  const result = await ask(a, tender_no);
  assert.equal(result.outcome, 'allowed');
  assert.match(result.request_reference, /^REQ\d{5}$/);
  assert.equal(result.payment_status, 'test');
  const [payment] = await payments(a.client_id);
  assert.equal(Number(payment.amount_cents), 9900);
  assert.equal(payment.status, 'test');
  const hold = (await db.query('SELECT client_id FROM tender_desk.pricing_holds WHERE tender_no=$1', [tender_no])).rows[0];
  assert.equal(hold.client_id, a.client_id);
  const audit = (await db.query("SELECT * FROM tender_desk.audit_log WHERE action='request_brief' ORDER BY id DESC LIMIT 1")).rows[0];
  assert.equal(audit.tender_no, tender_no);
  assert.equal(audit.summary.payment_status, 'test');
});

test('a second customer is refused before checkout without learning the holder', async () => {
  const a = await customer('Cedar');
  const b = await customer('Dahlia');
  const tender_no = await openTender();
  await ask(a, tender_no);
  const check = await b.ops.canRequest(tender_no, { now });
  assert.deepEqual(check, { ok: false, reason: 'held', message: refusal });
  const result = await ask(b, tender_no);
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.rule_id, 'G2');
  assert.equal(result.reason, refusal);
  assert.deepEqual(await payments(b.client_id), []);
  const audit = (await db.query('SELECT * FROM tender_desk.audit_log WHERE client_id=$1', [b.client_id])).rows;
  for (const text of [JSON.stringify(check), JSON.stringify(result), JSON.stringify(audit), JSON.stringify(await b.ops.context())]) {
    assert.ok(!text.includes(a.name) && !text.includes(a.client_id));
  }
});

test('checkout twice creates one request and one payment', async () => {
  const a = await customer('Elm');
  const tender_no = await openTender();
  const [first, second] = [await ask(a, tender_no), await ask(a, tender_no)];
  assert.equal(second.outcome, 'allowed');
  assert.equal(second.request_id, first.request_id);
  assert.equal((await payments(a.client_id)).length, 1);
  assert.deepEqual(await a.ops.canRequest(tender_no, { now }), { ok: false, reason: 'active', request_reference: first.request_reference });
});

test('a closed tender cannot be requested', async () => {
  const a = await customer('Fern');
  const tender_no = await openTender({ closes: '2026-11-21T13:00:00+08:00' });
  assert.equal((await a.ops.canRequest(tender_no, { now })).reason, 'closed');
  const result = await ask(a, tender_no);
  assert.equal(result.outcome, 'blocked');
  assert.match(result.reason, /closed/);
});

test('a pasted tender gets a stable PASTED id and needs five comparables', async () => {
  const a = await customer('Gorse');
  const pasted = { title: 'Event management for a heritage week', agency: 'Agency Z', text: 'Plan and run a week of events.' };
  const result = await a.ops.requestBrief({ pasted, terms: ['event management'] }, { now });
  assert.equal(result.outcome, 'allowed');
  assert.match(result.tender_no, /^PASTED-[a-f0-9]{16}$/);
  const thin = await a.ops.requestBrief({ pasted: { title: 'Submarine refit' }, terms: ['submarine'] }, { now });
  assert.equal(thin.outcome, 'blocked');
  assert.equal(thin.rule_id, 'G4');
  assert.equal(thin.reason, 'At least five comparable awards are needed for a brief. Try broader terms.');
});

test('declining a request releases the hold for the next customer', async () => {
  const a = await customer('Hazel');
  const b = await customer('Iris');
  const tender_no = await openTender();
  const requested = await ask(a, tender_no);
  const blank = await admin.declineRequest({ request_id: requested.request_id });
  assert.equal(blank.outcome, 'blocked');
  const declined = await admin.declineRequest({ request_id: requested.request_id, reason: 'We cannot advise on this scope.' });
  assert.equal(declined.outcome, 'declined');
  const mine = (await a.ops.context()).requests.find((request) => request.reference === requested.request_reference);
  assert.equal(mine.status, 'declined');
  assert.equal(mine.decline_reason, 'We cannot advise on this scope.');
  assert.deepEqual(await b.ops.canRequest(tender_no, { now }), { ok: true });
});

test('declining a drafted brief also releases the hold and closes the request', async () => {
  const a = await customer('Juniper');
  const b = await customer('Kale');
  const tender_no = await openTender();
  const requested = await ask(a, tender_no);
  const prepared = await admin.prepareDraft(requested.request_id);
  const saved = await admin.saveDraft({ request_id: requested.request_id, ...draft(prepared) });
  assert.equal(saved.outcome, 'allowed');
  await admin.reviewBrief({ brief_id: saved.brief_id, decision: 'declined', reason: 'Not a fit.' });
  const mine = (await a.ops.context()).requests[0];
  assert.equal(mine.status, 'declined');
  assert.equal(mine.decline_reason, 'Not a fit.');
  assert.deepEqual(await b.ops.canRequest(tender_no, { now }), { ok: true });
});

test('prepareDraft gives the facts a draft needs, with verified projects only', async () => {
  const a = await customer('Laurel');
  const tender_no = await openTender();
  const requested = await ask(a, tender_no);
  const prepared = await admin.prepareDraft(requested.request_id);
  assert.equal(prepared.tender.tender_no, tender_no);
  assert.equal(prepared.tender.title, 'Event management for a community festival');
  assert.equal(prepared.snapshot.status, 'ready');
  assert.equal(prepared.query_used, 'event management');
  assert.deepEqual(prepared.verifiedProjects.map((project) => project.title), ['Annual event for a ministry']);
  assert.equal(prepared.client.name, a.name);
  assert.deepEqual(prepared.fit, { category_match: true, within_capacity: true, related_projects: 1 });
});

test('saveDraft enforces verified citations and leaves the request open with the error', async () => {
  const a = await customer('Maple');
  const tender_no = await openTender();
  const requested = await ask(a, tender_no);
  const prepared = await admin.prepareDraft(requested.request_id);
  const result = await admin.saveDraft({ request_id: requested.request_id, ...draft(prepared, { credentials_cited: [a.projects[1].id] }) });
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.rule_id, 'G3');
  const row = (await db.query('SELECT status,last_error FROM tender_desk.brief_requests WHERE id=$1', [requested.request_id])).rows[0];
  assert.equal(row.status, 'requested');
  assert.match(row.last_error, /verified/);
  await admin.recordDraftFailure({ request_id: requested.request_id, reason: 'The model was unavailable. Try Redraft.' });
  const listed = (await admin.listBriefRequests({ now })).find((request) => request.id === requested.request_id);
  assert.equal(listed.last_error, 'The model was unavailable. Try Redraft.');
  assert.equal(listed.payment_status, 'test');
  assert.equal(listed.client_name, a.name);
  assert.equal(listed.closed, false);
});

test('approval marks the request approved and the customer sees the brief', async () => {
  const a = await customer('Nettle');
  const tender_no = await openTender();
  const requested = await ask(a, tender_no);
  const prepared = await admin.prepareDraft(requested.request_id);
  const saved = await admin.saveDraft({ request_id: requested.request_id, ...draft(prepared) });
  assert.equal((await a.ops.context()).requests[0].status, 'drafted');
  assert.equal((await a.ops.context()).requests[0].content, undefined);
  await admin.reviewBrief({ brief_id: saved.brief_id, decision: 'approved' });
  const [mine] = (await a.ops.context()).requests;
  assert.equal(mine.status, 'approved');
  assert.equal(mine.content, 'Bid: the scope fits the team.');
  assert.equal(mine.recommendation, 'bid');
});

test('cancelRequest frees the tender', async () => {
  const a = await customer('Oak');
  const b = await customer('Pine');
  const tender_no = await openTender();
  const requested = await ask(a, tender_no);
  assert.equal((await a.ops.cancelRequest({ request_id: requested.request_id })).outcome, 'allowed');
  assert.deepEqual(await b.ops.canRequest(tender_no, { now }), { ok: true });
  const other = await b.ops.cancelRequest({ request_id: requested.request_id });
  assert.equal(other.outcome, 'blocked');
});
