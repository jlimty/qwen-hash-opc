// Rehearses the ship bar (spec "Definition of done", steps 1-8) end to end, in process, on a throwaway in-memory
// database with the real GeBIZ award data and the LIVE GeBIZ RSS feeds. It can never touch production.
//   npm run assistant:rehearse -- --fake-llm     (no model; a canned clean draft)
//   OPENROUTER_API_KEY=... npm run assistant:rehearse   (or a key in ~/.td-openrouter-key)
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { PGlite } from '@electric-sql/pglite';
import { createConsoleHandler } from '../src/console-handler.mjs';
import { createCustomerAuth } from '../src/customer-auth.mjs';
import { createCustomerHandler } from '../src/customer-handler.mjs';
import { listOpenTenders, refreshOpenTenders } from '../src/gebiz-feed.mjs';
import { initializeGovernance } from '../src/governance-db.mjs';
import { createTenderDesk } from '../src/governance.mjs';
import { createOpenRouterLlm } from '../src/openrouter.mjs';
import { priceCheck } from '../src/price-check.mjs';
import { parseTenderCsv } from '../src/tender-data.mjs';
import { keywordTerms, readingSchema } from '../src/tender-reading.mjs';
import { draftSchema } from '../src/brief-drafting.mjs';
import { z } from 'zod';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: { 'fake-llm': { type: 'boolean' } }, allowPositionals: false, strict: true });
const results = [];
async function step(name, work) {
  try { const note = await work(); results.push(true); console.log(`PASS ${name}${note ? ` (${note})` : ''}`); } catch (error) { results.push(false); console.log(`FAIL ${name}: ${error.message}`); }
}
const must = (condition, message) => { if (!condition) throw new Error(message); };

// In-process stand-in for Neon Auth: sign-up, sign-in, sessions.
function fakeAuth() {
  const users = new Map(); const sessions = new Map();
  const json = (status, body, cookie) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...(cookie && { 'Set-Cookie': `__Secure-neon-auth.session_token=${cookie}; Path=/` }) } });
  return async (url, init = {}) => {
    const path = new URL(url).pathname; const body = init.body ? JSON.parse(init.body) : {};
    const issue = (id) => { const t = randomBytes(8).toString('hex'); sessions.set(t, id); return t; };
    if (path === '/sign-up/email') { const id = `user-${randomBytes(6).toString('hex')}`; users.set(body.email, { id, password: body.password }); return json(200, { user: { id } }, issue(id)); }
    if (path === '/sign-in/email') { const u = users.get(body.email); return u?.password === body.password ? json(200, { user: { id: u.id } }, issue(u.id)) : json(401, {}); }
    if (path === '/get-session') { const id = sessions.get(/session_token=([^;]+)/.exec(init.headers?.Cookie ?? '')?.[1]); return json(200, id ? { user: { id } } : null); }
    return json(200, {});
  };
}

function browser(handler, base) {
  const jar = new Map(); let csrf = '';
  async function go(method, path, form) {
    const headers = { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), 'x-forwarded-for': `10.0.${Math.floor(Math.random() * 250)}.1` };
    let body;
    if (form) { body = new URLSearchParams({ csrf, ...form }).toString(); headers['Content-Type'] = 'application/x-www-form-urlencoded'; }
    const response = await handler(new Request(`https://rehearsal.local${base}${path}`, { method, headers, body }), path.split('?')[0]);
    for (const c of response.headers.getSetCookie()) { const [pair] = c.split(';'); const at = pair.indexOf('='); if (/Max-Age=0/.test(c)) jar.delete(pair.slice(0, at)); else jar.set(pair.slice(0, at), pair.slice(at + 1)); }
    const text = await response.text();
    csrf = /name="csrf" value="([a-f0-9]{64})"/.exec(text)?.[1] ?? csrf;
    return { status: response.status, location: response.headers.get('location'), text };
  }
  return { get: (p) => go('GET', p), post: (p, f) => go('POST', p, f) };
}

const db = await PGlite.create();
try {
  await initializeGovernance(db);
  const dataset = parseTenderCsv(await readFile(join(root, 'data', 'GovernmentProcurementviaGeBIZ.csv'), 'utf8'));
  const adminToken = randomBytes(32).toString('hex');
  const desk = createTenderDesk({ database: db, dataset, adminToken });
  const admin = desk.admin(adminToken);
  const key = process.env.OPENROUTER_API_KEY?.trim() || (await readFile(join(homedir(), '.td-openrouter-key'), 'utf8').catch(() => '')).trim();
  if (!values['fake-llm'] && !key) throw new Error('No OpenRouter key: set OPENROUTER_API_KEY or ~/.td-openrouter-key, or pass --fake-llm.');
  let verifiedId;
  const llm = values['fake-llm'] ? async ({ name }) => {
    if (name === 'tender_reading') throw new Error('fake: use keywords');
    return { recommendation: 'bid', reasons: ['The scope matches a checked project of yours.', 'The buying agency issues this kind of work regularly.'],
      price_position: 'Between the lower quartile and the median: the scope is standard for this kind of work.', credentials_cited: [verifiedId] };
  } : createOpenRouterLlm({ apiKey: key });
  const models = { read: process.env.TD_MODEL_READ ?? 'qwen/qwen3.8-flash', draft: process.env.TD_MODEL_DRAFT ?? 'qwen/qwen3.8-max-0902' };
  if (!values['fake-llm']) {
    // Model check: one direct call per model, so a failure shows its real reason instead of a silent keyword fallback.
    const schemaOf = (schema) => { const { $schema, ...rest } = z.toJSONSchema(schema, { io: 'input' }); return rest; };
    const probe = async (label, model, name, schema, user, options) => {
      const started = Date.now();
      try { await llm({ model, name, jsonSchema: schemaOf(schema), system: 'Reply with JSON that matches the schema.', user, ...options }); console.log(`MODEL ${label} ${model}: OK in ${((Date.now() - started) / 1000).toFixed(1)}s`); }
      catch (error) { console.log(`MODEL ${label} ${model}: ${error.message} (after ${((Date.now() - started) / 1000).toFixed(1)}s)`); }
    };
    await probe('reading', models.read, 'tender_reading', readingSchema, 'Tender: Provision of event management services for a community festival.', { reasoning: { enabled: false }, timeoutMs: 20000 });
    await probe('drafting', models.draft, 'tender_brief', draftSchema, 'Recommend bid with one reason, a price position between the lower quartile and the median, and no citations.', { timeoutMs: 90000, reasoning: { effort: 'low' } });
  }
  const auth = createCustomerAuth({ baseUrl: 'https://auth.rehearsal', origin: 'https://rehearsal.local', adminUserId: 'admin-user-0001', fetchImpl: fakeAuth() });
  const app = createCustomerHandler({ desk, dataset, auth, llm, models, database: db, basePath: '/a', refresh: () => refreshOpenTenders(db) });
  const consoleApp = createConsoleHandler({ admin: desk.admin, adminToken, dataset, llm, models });
  const visitor = browser(app, '/a');
  let target;

  await step('1 open tenders from GeBIZ with closing dates, and a free price check', async () => {
    const landing = await visitor.get('/');
    const open = await listOpenTenders(db);
    must(open.length > 0, 'no open tenders came back from the GeBIZ feeds');
    must(landing.text.includes(open[0].tender_no) && /closes /.test(landing.text), 'landing page does not list the tenders with closing dates');
    // Pick the tender through the product itself: the first whose free check (with the real reader) offers a brief.
    let check;
    for (const tender of open.slice(0, 12)) {
      check = await visitor.post('/check', { tender_no: tender.tender_no });
      must(/Not a quote, and not a winning price/.test(check.text), 'price check has no limits line');
      if (/Create an account for a reviewed brief/.test(check.text)) { target = tender; break; }
    }
    must(target, 'none of the first 12 open tenders had enough comparable awards for a brief');
    return `${open.length} open tenders; checked ${target.tender_no}`;
  });
  await step('2 a pasted tender gets a price check or an honest too-few state', async () => {
    const check = await visitor.post('/check', { title: 'Provision of event management services for a community festival', agency: 'People\'s Association', text: '' });
    must(/Median award|Too few comparable awards/.test(check.text), 'no result state');
    return /Median award/.test(check.text) ? 'price range shown' : 'too few comparables';
  });
  const owner = browser(app, '/a');
  await step('3 sign up and create a profile; projects show as unverified', async () => {
    await owner.get('/signup');
    const s = await owner.post('/signup', { email: 'owner@rehearsal.invalid', password: 'rehearsal password', name: 'Owner' });
    must(s.status === 303, `sign-up returned ${s.status}`);
    await owner.get('/profile');
    const p = await owner.post('/profile', { name: 'Rehearsal Co (test)', capabilities: `Work of this kind: ${target.title}`, categories: target.category,
      team_size: '10', max_contract: '2,000,000', project_title_0: `Past project: ${keywordTerms(target.title).terms.join(' ')}`, project_agency_0: target.agency, project_title_1: 'Unchecked project' });
    must(p.status === 303, `profile returned ${p.status}: ${p.text.slice(0, 200)}`);
    must(/Unverified/.test((await owner.get('/home')).text), 'home does not show unverified projects');
  });
  await step('4 the admin verifies a project and the customer sees it checked', async () => {
    const project = (await db.query("SELECT id FROM tender_desk.projects WHERE title LIKE 'Past project:%'")).rows[0];
    verifiedId = project.id;
    must((await admin.verifyProject({ project_id: project.id, verified: true, note: 'Rehearsal check.' })).outcome === 'allowed', 'verify refused');
    must(/Checked/.test((await owner.get('/home')).text), 'home does not show the checked project');
  });
  let requestPath;
  await step('5 ask for a reviewed brief: test-mode checkout, then In review', async () => {
    const checkout = await owner.get(`/checkout?tender=${encodeURIComponent(target.tender_no)}`);
    must(/Test mode: no card is charged/.test(checkout.text), `no test-mode banner; the page says: ${/<p class="banner[^>]*>([^<]*)/.exec(checkout.text)?.[1] ?? 'nothing'}`);
    const terms = /name="terms" value="([^"]*)"/.exec(checkout.text)?.[1] ?? '';
    const category = /name="category" value="([^"]*)"/.exec(checkout.text)?.[1] ?? '';
    const paid = await owner.post('/checkout', { tender_no: target.tender_no, terms, category });
    must(paid.status === 303, `checkout returned ${paid.status}: ${paid.text.slice(0, 300)}`);
    requestPath = paid.location.slice(2);
    must(/In review/.test((await owner.get(requestPath)).text), 'request page is not In review');
  });
  await step('6 the admin drafts, reviews and approves; the customer sees the brief', async () => {
    const request = (await admin.listBriefRequests()).find((r) => r.status === 'requested');
    const c = browser(consoleApp, '');
    await c.post('/login', { token: adminToken });
    await c.get('/requests');
    const draftStarted = Date.now();
    await c.post(`/actions/request/${request.id}/draft`, {});
    const draftSeconds = ((Date.now() - draftStarted) / 1000).toFixed(1);
    const after = (await db.query('SELECT status,brief_id,last_error FROM tender_desk.brief_requests WHERE id=$1', [request.id])).rows[0];
    must(after.status === 'drafted', `draft did not save after ${draftSeconds}s: ${after.last_error}`);
    const brief = (await db.query('SELECT content,risk_facts FROM tender_desk.briefs WHERE id=$1', [after.brief_id])).rows[0];
    must((await admin.reviewBrief({ brief_id: after.brief_id, decision: 'approved' })).outcome === 'approved', 'approval refused');
    { const page = (await owner.get(requestPath)).text; must(/Our recommendation/.test(page) && !/##/.test(page), 'customer cannot see the approved brief, or it shows raw Markdown'); }
    console.log(`\n----- approved brief (drafted in ${draftSeconds}s) -----\n${brief.content}\n----- risk facts: ${JSON.stringify(brief.risk_facts)} -----\n`);
  });
  await step('7 a second customer is stopped before checkout without learning who holds it', async () => {
    const rival = browser(app, '/a');
    await rival.get('/signup');
    await rival.post('/signup', { email: 'rival@rehearsal.invalid', password: 'rehearsal password', name: 'Rival' });
    await rival.get('/profile');
    await rival.post('/profile', { name: 'Rival Co (test)', capabilities: 'Same work.', categories: target.category, team_size: '3', max_contract: '500000' });
    const page = await rival.get(`/checkout?tender=${encodeURIComponent(target.tender_no)}`);
    must(/Tender Desk already advises a client on this tender\./.test(page.text) && !/Pay S\$99/.test(page.text), 'rival was not refused');
    must(!page.text.includes('Rehearsal Co'), 'rival can see the holder');
  });
  await step('8 every step is in the audit log', async () => {
    const actions = new Set((await db.query('SELECT action FROM tender_desk.audit_log')).rows.map((r) => r.action));
    const missing = ['register_customer', 'verify_project', 'request_brief', 'save_draft', 'review_brief'].filter((a) => !actions.has(a));
    must(!missing.length, `missing audit actions: ${missing.join(', ')}`);
  });
} catch (error) {
  results.push(false);
  console.log(`FAIL setup: ${error.message}`);
} finally {
  await db.close();
}
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} steps passed.`);
process.exitCode = passed === results.length && results.length === 8 ? 0 : 1;
