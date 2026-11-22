import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { createConsoleHandler } from '../src/console-handler.mjs';
import { initializeGovernance } from '../src/governance-db.mjs';
import { createTenderDesk } from '../src/governance.mjs';
import { testUen } from './support/uen.mjs';
import { parseTenderCsv } from '../src/tender-data.mjs';

const header = 'tender_no,tender_description,agency,award_date,tender_detail_status,supplier_name,awarded_amt\n';
const dataset = parseTenderCsv(header + [1, 2, 3, 4, 5, 6].map((i) =>
  `OLD-${i},Event management services,Agency A,1/${i}/2025,Awarded to Suppliers,Past supplier,${i * 100000}.00`).join('\n'));
const adminToken = randomBytes(32).toString('hex');
const now = new Date('2026-11-22T02:00:00Z');
let db; let desk; let admin; let modelReply; let lastUser;

const llm = async () => { if (modelReply instanceof Error) throw modelReply; return modelReply; };
before(async () => {
  db = await PGlite.create();
  await initializeGovernance(db);
  desk = createTenderDesk({ database: db, dataset, adminToken });
  admin = desk.admin(adminToken);
});
after(async () => { await db?.close(); });

function consoleWith(options = {}) {
  const handle = createConsoleHandler({ admin: desk.admin, adminToken, dataset, now: () => now, ...options });
  const jar = new Map();
  let csrf = '';
  async function go(method, path, form) {
    const headers = { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') };
    let body;
    if (form) { body = new URLSearchParams({ csrf, ...form }).toString(); headers['Content-Type'] = 'application/x-www-form-urlencoded'; }
    const response = await handle(new Request(`http://127.0.0.1${path}`, { method, headers, body }), path.split('?')[0]);
    for (const cookie of response.headers.getSetCookie()) { const [pair] = cookie.split(';'); const at = pair.indexOf('='); jar.set(pair.slice(0, at), pair.slice(at + 1)); }
    const text = await response.text();
    csrf = /name="csrf" value="([a-f0-9]{64})"/.exec(text)?.[1] ?? csrf;
    return { status: response.status, location: response.headers.get('location'), text };
  }
  return { get: (p) => go('GET', p), post: (p, f) => go('POST', p, f),
    async login() { await go('POST', '/login', { token: adminToken }); return go('GET', '/requests'); } };
}

async function paidRequest({ closes = '2026-12-04T13:00:00+08:00' } = {}) {
  const userId = `user-${randomUUID().slice(0, 12)}`;
  const created = await desk.registerCustomer(userId, { uen: testUen(), name: `Quill Events ${randomUUID().slice(0, 6)}`, capabilities: 'Events', categories: ['events-community'],
    team_size: 5, max_contract_cents: 90000000, past_projects: [{ title: 'Event for a ministry', agency: 'Agency A' }] });
  await admin.verifyProject({ project_id: created.projects[0].id, verified: true, note: 'Checked.' });
  const tender_no = `LIVE${randomUUID().slice(0, 8).toUpperCase()}`;
  await db.query(`INSERT INTO tender_desk.open_tenders (tender_no,title,agency,closes_at,gebiz_url,source_feed,category)
    VALUES ($1,'Event management for a festival','Agency A',$2,'https://www.gebiz.gov.sg/x','Event Organising','events-community')`, [tender_no, closes]);
  const customer = await desk.customer(userId);
  const requested = await customer.requestBrief({ tender_no, terms: ['event management'] }, { now: new Date('2026-11-20T00:00:00Z') });
  assert.equal(requested.outcome, 'allowed');
  return { ...requested, project_id: created.projects[0].id, tender_no };
}
const clean = (projectId) => ({ recommendation: 'bid', reasons: ['The work matches your ministry event.'], price_position: { band: 'lower_quartile_to_median', why: 'The scope is standard and the team is small, so no premium.' }, requirements: [], questions: [], risks: [], credentials_cited: [projectId] });

test('the requests queue lists a paid request with its test payment', async () => {
  const request = await paidRequest();
  const page = await consoleWith({ llm, models: { draft: 'd' } }).login();
  assert.equal(page.status, 200);
  assert.match(page.text, new RegExp(request.request_reference));
  assert.match(page.text, /1 credit/);
  assert.match(page.text, />Draft</);
  assert.match(page.text, /Brief requests/);
});

test('Draft with a clean model reply creates a pending brief', async () => {
  const request = await paidRequest();
  modelReply = clean(request.project_id);
  const c = consoleWith({ llm, models: { draft: 'd' } });
  await c.login();
  const result = await c.post(`/actions/request/${request.request_id}/draft`, {});
  assert.equal(result.status, 303);
  const page = await c.get('/requests');
  assert.match(page.text, /Draft saved: review BRF\d{5}/);
  const row = (await db.query('SELECT status,brief_id FROM tender_desk.brief_requests WHERE id=$1', [request.request_id])).rows[0];
  assert.equal(row.status, 'drafted');
  assert.equal((await db.query('SELECT status FROM tender_desk.briefs WHERE id=$1', [row.brief_id])).rows[0].status, 'pending_approval');
});

test('Draft with an invented figure shows the failure and keeps the request open for Redraft', async () => {
  const request = await paidRequest();
  modelReply = { ...clean(request.project_id), reasons: ['Similar work went for S$777,777.'] };
  const c = consoleWith({ llm, models: { draft: 'd' } });
  await c.login();
  await c.post(`/actions/request/${request.request_id}/draft`, {});
  const page = await c.get('/requests');
  assert.match(page.text, /Draft failed: Draft contained figures not in the comparables/);
  assert.match(page.text, />Redraft</);
  assert.equal((await db.query('SELECT status FROM tender_desk.brief_requests WHERE id=$1', [request.request_id])).rows[0].status, 'requested');
});

test('decline needs a reason and frees the tender', async () => {
  const request = await paidRequest();
  const c = consoleWith({ llm, models: { draft: 'd' } });
  await c.login();
  await c.post(`/actions/request/${request.request_id}/decline`, { reason: '' });
  assert.match((await c.get('/requests')).text, /A decline needs a reason/);
  await c.post(`/actions/request/${request.request_id}/decline`, { reason: 'Outside what we can advise on.' });
  assert.match((await c.get('/requests')).text, /Request declined/);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM tender_desk.pricing_holds WHERE tender_no=$1', [request.tender_no])).rows[0].n, 0);
});

test('a closed tender shows the closed badge', async () => {
  const request = await paidRequest({ closes: '2026-11-21T13:00:00+08:00' });
  const page = await consoleWith({ llm, models: { draft: 'd' } }).login();
  const row = page.text.slice(page.text.indexOf(request.request_reference));
  assert.match(row.slice(0, 1500), /Closed/);
});

test('without a model the Draft button explains the missing key', async () => {
  await paidRequest();
  const page = await consoleWith().login();
  assert.match(page.text, /AI drafting is not configured \(TD_OPENROUTER_KEY\)\./);
  assert.doesNotMatch(page.text, />Draft</);
});

test('the console refuses to start without an admin function, in plain English', () => {
  assert.throws(() => createConsoleHandler({ adminToken, dataset }), { message: 'An admin function is required.' });
});

test('the overview lists paid requests waiting for a draft, with their age', async () => {
  const request = await paidRequest();
  const c = consoleWith({ llm, models: { draft: 'd' } });
  await c.login();
  const overview = await c.get('/');
  assert.match(overview.text, /Paid request/);
  assert.match(overview.text, new RegExp(`${request.request_reference}[\\s\\S]{0,400}Event management for a festival`));
  assert.match(overview.text, /paid .*ago|paid just now/);
});

test('the audit log names who acted: the admin for drafts and decisions, the customer for requests', async () => {
  const request = await paidRequest();
  modelReply = clean(request.project_id);
  const c = consoleWith({ llm, models: { draft: 'd' } });
  await c.login();
  await c.post(`/actions/request/${request.request_id}/draft`, {});
  const audit = await c.get('/audit');
  const row = (label) => { const at = audit.text.indexOf(label); assert.ok(at > 0, label); return audit.text.slice(audit.text.lastIndexOf('<tr', at), audit.text.indexOf('</tr>', at)); };
  assert.match(row('Saved an AI draft'), /You/);
  assert.match(row('Asked for a brief'), /Quill Events/);
  assert.doesNotMatch(audit.text, />save_draft<|>request_brief<|>register_customer</);
});

test('the brief review page shows the live agency and the comparable awards behind the band', async () => {
  const request = await paidRequest();
  modelReply = clean(request.project_id);
  const c = consoleWith({ llm, models: { draft: 'd' } });
  await c.login();
  await c.post(`/actions/request/${request.request_id}/draft`, {});
  const briefRef = (await db.query('SELECT b.reference_number FROM tender_desk.briefs b JOIN tender_desk.brief_requests r ON r.brief_id=b.id WHERE r.id=$1', [request.request_id])).rows[0].reference_number;
  const page = await c.get(`/briefs/BRF${String(briefRef).padStart(5, '0')}`);
  assert.match(page.text, /<dt>Agency<\/dt><dd>Agency A<\/dd>/);
  assert.match(page.text, /Comparable awards/);
  assert.match(page.text, /OLD-6/);
  assert.match(page.text, /Lower quartile/);
  assert.doesNotMatch(page.text, /##/);
});

test('the brief page lets the admin edit the draft, and every check re-runs on save', async () => {
  const request = await paidRequest();
  modelReply = clean(request.project_id);
  const c = consoleWith({ llm, models: { draft: 'd' } });
  await c.login();
  await c.post(`/actions/request/${request.request_id}/draft`, {});
  const brief = (await db.query('SELECT b.id,b.reference_number FROM tender_desk.briefs b JOIN tender_desk.brief_requests r ON r.brief_id=b.id WHERE r.id=$1', [request.request_id])).rows[0];
  const ref = `/briefs/BRF${String(brief.reference_number).padStart(5, '0')}`;
  const page = await c.get(ref);
  assert.match(page.text, /action="\/actions\/brief\/[^"]+\/edit"/);
  assert.match(page.text, /name="reasons"/);
  assert.match(page.text, /AI drafts it; you can edit any part before approving/);
  await c.post(`/actions/brief/${brief.id}/edit`, { recommendation: 'bid', reasons: 'The work matches your ministry event.\nThe agency buys this regularly.',
    band: 'median_to_upper_quartile', why: 'Your ministry track record justifies sitting above the middle of past awards.', questions: 'Is there a site visit?', risks: '' });
  const saved = (await db.query('SELECT parts,content FROM tender_desk.briefs WHERE id=$1', [brief.id])).rows[0];
  assert.equal(saved.parts.price_position.band, 'median_to_upper_quartile');
  assert.match(saved.content, /Is there a site visit\?/);
  await c.post(`/actions/brief/${brief.id}/edit`, { recommendation: 'bid', reasons: 'Similar work went for S$999,999.', band: 'median_to_upper_quartile',
    why: 'Your ministry track record justifies sitting above the middle of past awards.', questions: '', risks: '' });
  assert.match((await c.get(ref)).text, /Edit not saved: Draft repeated the price position|Edit not saved: Draft contained figures/);
});

test('a redraft with a note sends the note to the model and replaces the pending draft', async () => {
  const request = await paidRequest();
  modelReply = clean(request.project_id);
  const c = consoleWith({ llm: async (r) => { lastUser = JSON.parse(r.user); return modelReply; }, models: { draft: 'd' } });
  await c.login();
  await c.post(`/actions/request/${request.request_id}/draft`, {});
  const brief = (await db.query('SELECT b.id FROM tender_desk.briefs b JOIN tender_desk.brief_requests r ON r.brief_id=b.id WHERE r.id=$1', [request.request_id])).rows[0];
  modelReply = { ...clean(request.project_id), reasons: ['The redraft mentions the school programmes.'] };
  await c.post(`/actions/brief/${brief.id}/redraft`, { note: 'Mention the school programmes.' });
  assert.equal(lastUser.admin_note, 'Mention the school programmes.');
  assert.match((await db.query('SELECT content FROM tender_desk.briefs WHERE id=$1', [brief.id])).rows[0].content, /redraft mentions the school programmes/);
});

async function draftedBrief(c) {
  const request = await paidRequest();
  modelReply = clean(request.project_id);
  await c.post(`/actions/request/${request.request_id}/draft`, {});
  return (await db.query('SELECT b.* FROM tender_desk.briefs b JOIN tender_desk.brief_requests r ON r.brief_id=b.id WHERE r.id=$1', [request.request_id])).rows[0];
}
const note = (brief, action) => db.query("INSERT INTO tender_desk.review_notes (subject,subject_id,author,note,suggested_action) VALUES ('brief',$1,'agent:test',$2,$3)",
  [brief.id, `Checked against the comparables; ${action}.`, action]);

test("the brief page shows the AI reviewer's notes as suggestions", async () => {
  const c = consoleWith({ llm, models: { draft: 'd' } });
  await c.login();
  const brief = await draftedBrief(c);
  await note(brief, 'approve');
  const page = await c.get(`/briefs/BRF${String(brief.reference_number).padStart(5, '0')}`);
  assert.match(page.text, /AI reviewer's notes \(suggestions; you decide\)/);
  assert.match(page.text, /Checked against the comparables; approve\./);
  assert.match(page.text, /Suggests: approve/);
});

test('batch approve covers only low or medium risk briefs the AI reviewer suggested approving', async () => {
  const c = consoleWith({ llm, models: { draft: 'd' } });
  await c.login();
  const one = await draftedBrief(c);
  const two = await draftedBrief(c);
  await note(one, 'approve');
  await note(two, 'redraft');
  await db.query("UPDATE tender_desk.briefs SET risk_level='medium' WHERE id=ANY($1::uuid[])", [[one.id, two.id]]);
  const list = await c.get('/briefs');
  assert.match(list.text, new RegExp(`name="brief_ids" value="${one.id}:1"`));
  assert.doesNotMatch(list.text, new RegExp(`name="brief_ids" value="${two.id}:`));
  const done = await c.post('/actions/briefs/batch-approve', { brief_ids: `${one.id}:1` });
  assert.equal(done.status, 303);
  assert.match((await c.get('/briefs')).text, /Approved 1 brief/);
  assert.equal((await db.query('SELECT status FROM tender_desk.briefs WHERE id=$1', [one.id])).rows[0].status, 'approved');
  assert.equal((await db.query('SELECT status FROM tender_desk.briefs WHERE id=$1', [two.id])).rows[0].status, 'pending_approval');
  await c.post('/actions/briefs/batch-approve', { brief_ids: `${two.id}:1` });
  assert.equal((await db.query('SELECT status FROM tender_desk.briefs WHERE id=$1', [two.id])).rows[0].status, 'pending_approval', 'not eligible, so not approved');
});

test('the operator page issues a QwenWork connector once and lists it for revoking', async () => {
  const c = consoleWith({ llm, models: { draft: 'd' }, connector: { url: 'https://site.example/mcp', origin: 'https://site.example', timeout: 60 } });
  await c.login();
  const page = await c.get('/operator');
  assert.match(page.text, /Your QwenWork back office/);
  const shown = await c.post('/actions/operator/issue', {});
  assert.equal(shown.status, 200);
  assert.match(shown.text, /&quot;mcpServers&quot;/);
  assert.match(shown.text, /shown once/i);
  assert.match(shown.text, /tender-desk-operator/);
  assert.doesNotMatch((await c.get('/operator')).text, /mcpServers/, 'the connector is not shown again');
  assert.match((await c.get('/operator')).text, /Revoke/);
});

test('the QwenWork page opens QwenWork in a new tab (it cannot be embedded)', async () => {
  const c = consoleWith({ llm, models: { draft: 'd' } });
  await c.login();
  const page = await c.get('/operator');
  assert.match(page.text, /<a class="btn primary" href="https:\/\/qwenwork\.ai\/app\/" target="_blank" rel="noopener noreferrer">Open QwenWork ↗<\/a>/);
});
