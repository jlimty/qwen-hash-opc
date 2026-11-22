import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { createCustomerAuth } from '../src/customer-auth.mjs';
import { createCustomerHandler } from '../src/customer-handler.mjs';
import { feeds } from '../src/gebiz-feed.mjs';
import { initializeGovernance } from '../src/governance-db.mjs';
import { createTenderDesk } from '../src/governance.mjs';
import { parseTenderCsv } from '../src/tender-data.mjs';
import { fakeNeonAuth } from './support/fake-neon-auth.mjs';

const xml = await readFile(new URL('./fixtures/gebiz-professional.xml', import.meta.url), 'utf8');
const header = 'tender_no,tender_description,agency,award_date,tender_detail_status,supplier_name,awarded_amt\n';
const dataset = parseTenderCsv(header + [
  ...[1, 2, 3, 4, 5, 6].map((i) => `AUD-${i},Audit certification services,Agency A,1/${i}/2025,Awarded to Suppliers,Auditor ${i},${i * 50000}.00`),
  ...[1, 2, 3, 4, 5, 6].map((i) => `EVT-${i},Event management services,Agency B,2/${i}/2025,Awarded to Suppliers,Events Co,${i * 90000}.00`),
].join('\n'));
const adminToken = randomBytes(32).toString('hex');
const base = '/functions/v1/app/assistant';
const origin = 'https://site.example';
const professional = feeds.find((feed) => feed.name === 'Professional Services');
let db; let desk; let feedUp = true; let handler; let llmCalls = 0;

function fetchFeeds(url) {
  if (!feedUp) return Promise.reject(new Error('GeBIZ down'));
  return Promise.resolve(new Response(url === professional.url ? xml : '<rss version="2.0"><channel></channel></rss>', { status: 200 }));
}
const llm = async ({ name }) => {
  llmCalls++;
  if (name === 'tender_reading') return { terms: ['audit'], category: 'other', agency: null };
  throw new Error('not used here');
};

before(async () => {
  db = await PGlite.create();
  await initializeGovernance(db);
  desk = createTenderDesk({ database: db, dataset, adminToken });
  const fake = fakeNeonAuth();
  const auth = createCustomerAuth({ baseUrl: 'https://auth.example', origin, adminUserId: 'admin-user-0001', fetchImpl: fake.fetchImpl });
  handler = createCustomerHandler({ desk, dataset, auth, llm, models: { read: 'r', draft: 'd' }, database, basePath: base, secureCookies: true,
    refresh: () => import('../src/gebiz-feed.mjs').then(({ refreshOpenTenders }) => refreshOpenTenders(db, { fetchImpl: fetchFeeds, now: new Date('2026-11-22T00:00:00Z'), maxAgeMs: 0 })),
    now: () => new Date('2026-11-22T02:00:00Z') });
});
after(async () => { await db?.close(); });
const database = { query: (...a) => db.query(...a), transaction: (fn) => db.transaction(fn) };

// A tiny browser: keeps cookies, follows nothing, posts forms with the page's CSRF token.
function browser(ip = '10.0.0.1') {
  const jar = new Map();
  let csrf = '';
  async function go(method, path, form) {
    const headers = { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), 'x-forwarded-for': ip, Origin: origin };
    let body;
    if (form) { body = new URLSearchParams({ csrf, ...form }).toString(); headers['Content-Type'] = 'application/x-www-form-urlencoded'; }
    const response = await handler(new Request(`${origin}${base}${path}`, { method, headers, body }), path.split('?')[0]);
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const at = pair.indexOf('=');
      const value = pair.slice(at + 1);
      if (/Max-Age=0/.test(cookie)) jar.delete(pair.slice(0, at)); else jar.set(pair.slice(0, at), value);
    }
    const text = await response.text();
    csrf = /name="csrf" value="([a-f0-9]{64})"/.exec(text)?.[1] ?? csrf;
    return { status: response.status, location: response.headers.get('location'), text, headers: response.headers };
  }
  return { get: (path) => go('GET', path), post: (path, form) => go('POST', path, form), jar };
}

async function signedUpCustomer(label) {
  const b = browser(`10.1.0.${Math.floor(Math.random() * 200)}`);
  await b.get('/signup');
  const signup = await b.post('/signup', { email: `${label}-${randomBytes(3).toString('hex')}@sme.example`, password: 'a long password', name: 'Owner' });
  assert.equal(signup.status, 303);
  assert.equal(signup.location, `${base}/profile`);
  await b.get('/profile');
  const saved = await b.post('/profile', { name: `${label} Audit ${randomBytes(3).toString('hex')}`, capabilities: 'Audit and certification work.',
    categories: 'other', team_size: '6', max_contract: '500,000', project_title_0: 'Audit for a polytechnic', project_agency_0: 'Agency A',
    project_value_0: '120000', project_gebiz_0: '', project_title_1: 'Unchecked gala' });
  assert.equal(saved.status, 303, saved.text.slice(0, 400));
  assert.equal(saved.location, `${base}/home`);
  return b;
}

test('anonymous visitor sees open tenders and runs a price check', async () => {
  const b = browser();
  const landing = await b.get('/');
  assert.equal(landing.status, 200);
  assert.match(landing.text, /RPO000ETQ26000129/);
  assert.match(landing.text, /Tenders last updated/);
  assert.doesNotMatch(landing.text, /admin/i);
  assert.match(landing.headers.get('content-security-policy'), /default-src 'none'/);
  const check = await b.post('/check', { tender_no: 'RPO000ETQ26000129' });
  assert.equal(check.status, 200);
  assert.match(check.text, /Past awards from April 2021 to March 2026\. Not a quote, and not a winning price\. GeBIZ publishes winning amounts only\./);
  assert.match(check.text, /AUD-6/);
  assert.match(check.text, /name="terms"[^>]*value="audit"/);
  const cached = (await db.query("SELECT terms FROM tender_desk.open_tenders WHERE tender_no='RPO000ETQ26000129'")).rows[0].terms;
  assert.deepEqual(cached, ['audit']);
  const calls = llmCalls;
  await b.post('/check', { tender_no: 'RPO000ETQ26000129' });
  assert.equal(llmCalls, calls, 'cached terms are reused');
});

test('editing the terms reruns the check with the new terms', async () => {
  const b = browser('10.0.0.2');
  await b.get('/');
  const check = await b.post('/check', { tender_no: 'RPO000ETQ26000129', terms: 'event management' });
  assert.match(check.text, /EVT-6/);
});

test('pasted gibberish gets the too-few-comparables state, and long text is cut with a notice', async () => {
  const b = browser('10.0.0.3');
  await b.get('/');
  const check = await b.post('/check', { title: 'Qqqzzz', agency: 'Nobody', text: 'x'.repeat(5000), terms: 'qqqzzz' });
  assert.equal(check.status, 200);
  assert.match(check.text, /Too few comparable awards/);
  assert.match(check.text, /Only the first 4000 characters were read\./);
});

test('the 21st anonymous check in an hour is refused with 429', async () => {
  const b = browser('10.9.9.9');
  await b.get('/');
  for (let i = 0; i < 20; i++) assert.equal((await b.post('/check', { tender_no: 'RPO000ETQ26000129' })).status, 200);
  assert.equal((await b.post('/check', { tender_no: 'RPO000ETQ26000129' })).status, 429);
});

test('a POST without the page token is refused', async () => {
  const b = browser('10.0.0.4');
  const response = await b.post('/check', { tender_no: 'RPO000ETQ26000129' });
  assert.equal(response.status, 403);
});

test('GeBIZ down still renders the stored tenders', async () => {
  feedUp = false;
  try {
    const landing = await browser('10.0.0.5').get('/');
    assert.equal(landing.status, 200);
    assert.match(landing.text, /RPO000ETQ26000129/);
  } finally { feedUp = true; }
});

test('sign up, profile, and home shows projects with their verification state', async () => {
  const b = await signedUpCustomer('Aster');
  const home = await b.get('/home');
  assert.equal(home.status, 200);
  assert.match(home.text, /Audit for a polytechnic/);
  assert.match(home.text, /Unverified: we check these against GeBIZ before a brief can cite them/);
  assert.match(home.text, /RPO000ETQ26000129/);
  assert.doesNotMatch(home.text, /admin/i);
  assert.equal((await b.get('/')).location, `${base}/home`);
});

test('checkout shows the test-mode banner, and paying twice creates one request', async () => {
  const b = await signedUpCustomer('Birch');
  const checkout = await b.get('/checkout?tender=RPO000ETQ26000129');
  assert.equal(checkout.status, 200);
  assert.match(checkout.text, /Test mode: no card is charged/);
  assert.match(checkout.text, /S\$99\.00/);
  assert.match(checkout.text, /Pay S\$99 \(test mode\)/);
  const paid = await b.post('/checkout', { tender_no: 'RPO000ETQ26000129', terms: 'audit' });
  assert.equal(paid.status, 303);
  assert.match(paid.location, new RegExp(`^${base}/requests/REQ\\d{5}$`));
  const again = await b.post('/checkout', { tender_no: 'RPO000ETQ26000129', terms: 'audit' });
  assert.equal(again.location, paid.location);
  const request = await b.get(paid.location.slice(base.length));
  assert.match(request.text, /In review: usually within one business day/);
  const { rows } = await db.query("SELECT count(*)::int AS n FROM tender_desk.payments p JOIN tender_desk.brief_requests r ON r.id=p.request_id WHERE r.tender_no='RPO000ETQ26000129'");
  assert.equal(rows[0].n, 1);
});

test('a second customer sees the refusal and no pay button', async () => {
  const b = await signedUpCustomer('Cedar');
  const checkout = await b.get('/checkout?tender=RPO000ETQ26000129');
  assert.match(checkout.text, /Tender Desk already advises a client on this tender\./);
  assert.doesNotMatch(checkout.text, /Pay S\$99/);
  assert.doesNotMatch(checkout.text, /Birch/);
});

test('a pasted tender goes through checkout too', async () => {
  const b = await signedUpCustomer('Dahlia');
  const start = await b.post('/checkout/start', { title: 'Event management for a heritage week', agency: 'Agency Q', text: 'Run the events.', terms: 'event management' });
  assert.equal(start.status, 200);
  assert.match(start.text, /Pay S\$99 \(test mode\)/);
  const paid = await b.post('/checkout', { title: 'Event management for a heritage week', agency: 'Agency Q', text: 'Run the events.', terms: 'event management' });
  assert.equal(paid.status, 303);
});

test('checkout needs an account', async () => {
  const response = await browser('10.0.0.6').get('/checkout?tender=RPO000ETQ26000129');
  assert.equal(response.status, 303);
  assert.equal(response.location, `${base}/signup`);
});

test("a customer cannot open another customer's request", async () => {
  const owner = await signedUpCustomer('Elm');
  const paid = await owner.post('/checkout/start', { title: 'Audit certification for a school', agency: 'Agency A', text: '', terms: 'audit' });
  assert.equal(paid.status, 200);
  const done = await owner.post('/checkout', { title: 'Audit certification for a school', agency: 'Agency A', text: '', terms: 'audit' });
  const other = await signedUpCustomer('Fern');
  assert.equal((await other.get(done.location.slice(base.length))).status, 404);
});

test('sign out ends the session', async () => {
  const b = await signedUpCustomer('Gorse');
  await b.get('/home');
  const out = await b.post('/signout', {});
  assert.equal(out.status, 303);
  assert.equal((await b.get('/home')).location, `${base}/signin`);
});
