import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { createConsoleHandler } from '../src/console-handler.mjs';
import { initializeGovernance } from '../src/governance-db.mjs';
import { createTenderDesk } from '../src/governance.mjs';
import { parseTenderCsv } from '../src/tender-data.mjs';

const header = 'tender_no,tender_description,agency,award_date,tender_detail_status,supplier_name,awarded_amt\n';
const dataset = parseTenderCsv(header + [1, 2, 3, 4, 5, 6].map((i) =>
  `OLD-${i},Event management services,Agency A,1/${i}/2025,Awarded to Suppliers,Past supplier,${i * 100000}.00`).join('\n'));
const adminToken = randomBytes(32).toString('hex');
const now = new Date('2026-11-22T02:00:00Z');
let db; let desk; let admin; let modelReply;

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
  const created = await desk.registerCustomer(userId, { name: `Quill Events ${randomUUID().slice(0, 6)}`, capabilities: 'Events', categories: ['events-community'],
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
const clean = (projectId) => ({ recommendation: 'bid', reasons: ['The work matches your ministry event.'], price_position: 'Between the lower quartile and the median, because the scope is standard and the team is small.', credentials_cited: [projectId] });

test('the requests queue lists a paid request with its test payment', async () => {
  const request = await paidRequest();
  const page = await consoleWith({ llm, models: { draft: 'd' } }).login();
  assert.equal(page.status, 200);
  assert.match(page.text, new RegExp(request.request_reference));
  assert.match(page.text, /Test payment · S\$99\.00/);
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
