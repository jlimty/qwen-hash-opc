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
import { testUen } from './support/uen.mjs';

const xml = await readFile(new URL('./fixtures/gebiz-professional.xml', import.meta.url), 'utf8');
const header = 'tender_no,tender_description,agency,award_date,tender_detail_status,supplier_name,awarded_amt\n';
const dataset = parseTenderCsv(header + [
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => `AUD-${i},Audit certification services,Agency A,1/${i}/2025,Awarded to Suppliers,Auditor ${i},${i * 50000}.00`),
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
  if (name === 'profile_reading') return { capabilities: 'Audits for public bodies and schools, run by chartered accountants.', categories: ['other'], team_size: 12, max_contract_sgd: null, past_projects: [{ title: 'Audit for a polytechnic', agency: null, value_sgd: null }] };
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
  const saved = await b.post('/profile', { name: `${label} Audit ${randomBytes(3).toString('hex')}`, uen: testUen(), capabilities: 'Audit and certification work.',
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
  assert.match(home.text, /Not checked yet: we check these against GeBIZ before a brief can cite them/);
  assert.match(home.text, /RPO000ETQ26000129/);
  assert.doesNotMatch(home.text, /admin/i);
  assert.equal((await b.get('/')).location, `${base}/home`);
});

test('checkout spends one credit, and paying twice creates one request', async () => {
  const b = await signedUpCustomer('Birch');
  const checkout = await b.get('/checkout?tender=RPO000ETQ26000129');
  assert.equal(checkout.status, 200);
  assert.match(checkout.text, /Free: your first brief/, 'the unspent welcome credit is shown as the free first brief');
  assert.match(checkout.text, /Use 1 credit|Get my free brief/);
  const paid = await b.post('/checkout', { tender_no: 'RPO000ETQ26000129', terms: 'audit' });
  assert.equal(paid.status, 303);
  assert.match(paid.location, new RegExp(`^${base}/requests/REQ\\d{5}$`));
  const again = await b.post('/checkout', { tender_no: 'RPO000ETQ26000129', terms: 'audit' });
  assert.equal(again.location, paid.location);
  const request = await b.get(paid.location.slice(base.length));
  assert.match(request.text, /In review: usually within one business day/);
  const { rows } = await db.query("SELECT count(*)::int AS n FROM tender_desk.credit_ledger l JOIN tender_desk.brief_requests r ON r.id=l.request_id WHERE r.tender_no='RPO000ETQ26000129' AND l.reason='brief'");
  assert.equal(rows[0].n, 1);
});

test('a second customer sees the refusal and no pay button', async () => {
  const b = await signedUpCustomer('Cedar');
  const checkout = await b.get('/checkout?tender=RPO000ETQ26000129');
  assert.match(checkout.text, /This tender isn(&#39;|')t available for a reviewed brief right now\./);
  assert.doesNotMatch(checkout.text, /Use 1 credit|Get my free brief/);
  assert.doesNotMatch(checkout.text, /Birch/);
});

test('a pasted tender goes through checkout too', async () => {
  const b = await signedUpCustomer('Dahlia');
  const start = await b.post('/checkout/start', { title: 'Event management for a heritage week', agency: 'Agency Q', text: 'Run the events.', terms: 'event management' });
  assert.equal(start.status, 200);
  assert.match(start.text, /Use 1 credit|Get my free brief/);
  const paid = await b.post('/checkout', { title: 'Event management for a heritage week', agency: 'Agency Q', text: 'Run the events.', terms: 'event management', confirm_outside: 'yes' });
  assert.equal(paid.status, 303);
});

test('checkout needs an account', async () => {
  const response = await browser('10.0.0.6').get('/checkout?tender=RPO000ETQ26000129');
  assert.equal(response.status, 303);
  assert.equal(response.location, `${base}/signup?next=${encodeURIComponent('/checkout?tender=RPO000ETQ26000129')}`);
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

test('a too-few check does not offer a brief, and checkout with such terms hides the pay button', async () => {
  const b = await signedUpCustomer('Hazel');
  const thin = await b.post('/check', { tender_no: 'MOESCHETQ26006510', terms: 'qqqzzz' });
  assert.doesNotMatch(thin.text, /Ask for a reviewed brief/);
  assert.match(thin.text, /A reviewed brief needs at least five comparable awards/);
  const checkout = await b.get('/checkout?tender=MOESCHETQ26006510&terms=qqqzzz');
  assert.doesNotMatch(checkout.text, /Use 1 credit|Get my free brief/);
  assert.match(checkout.text, /A reviewed brief needs at least five comparable awards/);
});

test('edited terms carry into checkout, and the brief is priced on the band the customer saw', async () => {
  const b = await signedUpCustomer('Iris');
  const check = await b.post('/check', { tender_no: 'MOESCHETQ26006510', terms: 'event management' });
  const link = /href="[^"]*\/checkout\?([^"]+)"/.exec(check.text)?.[1].replaceAll('&amp;', '&');
  assert.ok(link, 'the check page links to checkout');
  assert.match(link, /terms=event(\+|%20)management/);
  // The payment half uses a pasted tender, so the band can be compared with what the customer saw.
  const pasted = { title: 'Event management for a district fair', agency: 'Agency Z', text: '' };
  const seen = await b.post('/check', { ...pasted, terms: 'event management' });
  // Six event awards are thin evidence, so the customer saw the count and a rounded spread, not quartiles.
  const spread = /(\d+ comparable awards, from about [^<]+)</.exec(seen.text)?.[1];
  assert.ok(spread, 'the check page shows the rounded spread');
  const start = await b.post('/checkout/start', { ...pasted, terms: 'event management', category: 'other' });
  assert.match(start.text, /Use 1 credit|Get my free brief/);
  const paid = await b.post('/checkout', { ...pasted, terms: 'event management', category: 'other' });
  assert.equal(paid.status, 303);
  const row = (await db.query("SELECT s.snapshot FROM tender_desk.brief_requests r JOIN tender_desk.stats_snapshots s ON s.stat_id=r.stat_id AND s.client_id=r.client_id WHERE r.title=$1", [pasted.title])).rows[0];
  const { roughSpread } = await import('../src/brief-risk.mjs');
  assert.equal(`${row.snapshot.n} comparable awards, ${roughSpread(row.snapshot.comparables.map((c) => c.total_awarded_cents))}`, spread);
});

test('a 20,000-character paste is read, cut to 4000 with a notice', async () => {
  const b = browser('10.0.0.7');
  await b.get('/');
  const check = await b.post('/check', { title: 'Audit certification', agency: 'Agency A', text: 'Audit, certification; scope. '.repeat(700) });
  assert.equal(check.status, 200);
  assert.match(check.text, /Only the first 4000 characters were read\./);
});

test('checkout tells a customer with no checked projects what a brief can cite', async () => {
  const b = browser('10.0.0.8');
  await b.get('/signup');
  await b.post('/signup', { email: `nocheck-${randomBytes(3).toString('hex')}@sme.example`, password: 'a long password', name: 'Owner' });
  await b.get('/profile');
  await b.post('/profile', { name: `Nocheck ${randomBytes(3).toString('hex')}`, uen: testUen(), capabilities: 'Audit.', categories: 'other', team_size: '2', max_contract: '100000', project_title_0: 'Unchecked audit' });
  const start = await b.post('/checkout/start', { title: 'Audit certification for a hospital', agency: 'Agency A', text: '', terms: 'audit' });
  assert.match(start.text, /None of your projects has been checked yet/);
  assert.match(start.text, /Use 1 credit|Get my free brief/);
});

test('after a brief is approved, checkout for the same tender opens that brief instead of charging again', async () => {
  const b = await signedUpCustomer('Juniper');
  const pasted = { title: 'Audit certification for a library', agency: 'Agency A', text: '', terms: 'audit' };
  await b.post('/checkout/start', pasted);
  const paid = await b.post('/checkout', pasted);
  const ref = paid.location.split('/').pop();
  const request = (await db.query('SELECT * FROM tender_desk.brief_requests WHERE reference_number=$1', [Number(ref.slice(3))])).rows[0];
  const admin = desk.admin(adminToken);
  const prepared = await admin.prepareDraft(request.id);
  const saved = await admin.saveDraft({ request_id: request.id, recommendation: 'bid', content: 'Bid.', credentials_cited: [] });
  assert.equal(saved.outcome, 'allowed', JSON.stringify(saved) + JSON.stringify(prepared.snapshot?.status));
  await admin.reviewBrief({ brief_id: saved.brief_id, decision: 'approved' });
  const again = await b.post('/checkout/start', pasted);
  assert.equal(again.status, 303);
  assert.equal(again.location, paid.location);
});

test('a malformed customer cookie on sign-out does not crash', async () => {
  const b = browser('10.0.0.9');
  await b.get('/');
  b.jar.set('td_customer', '%E0%A4%A');
  const out = await b.post('/signout', {});
  assert.equal(out.status, 303);
});

test('the rate limit keys on the proxy-appended address, not the first forwarded entry', async () => {
  const b = browser('203.0.113.9');
  await b.get('/');
  for (let i = 0; i < 20; i++) await b.post('/check', { tender_no: 'RPO000ETQ26000129' });
  const spoof = await handler(new Request(`${origin}${base}/check`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded',
    'x-forwarded-for': `198.51.100.${Math.floor(Math.random() * 200)}, 203.0.113.9`, Cookie: [...b.jar].map(([k, v]) => `${k}=${v}`).join('; ') },
  body: new URLSearchParams({ csrf: b.jar.get('td_ccsrf'), tender_no: 'RPO000ETQ26000129' }).toString() }), '/check');
  assert.equal(spoof.status, 429);
});

test('home reads a tender the same way the free check does, so the two never disagree', async () => {
  const b = await signedUpCustomer('Quill');
  await db.query("UPDATE tender_desk.open_tenders SET terms=NULL WHERE tender_no='RPO000ETQ26000129'");
  const home = await b.get('/home');
  const row = home.text.slice(home.text.indexOf('RPO000ETQ26000129'), home.text.indexOf('</li>', home.text.indexOf('RPO000ETQ26000129')));
  assert.match(row, /Middle half of past awards: S\$162,500 to S\$387,500 \(median S\$275,000, 10 awards\)/);
  assert.deepEqual((await db.query("SELECT terms FROM tender_desk.open_tenders WHERE tender_no='RPO000ETQ26000129'")).rows[0].terms, ['audit'], 'home stored the reading the free check uses');
  const check = await b.post('/check', { tender_no: 'RPO000ETQ26000129' });
  assert.match(check.text, /10 comparable awards|S\$275,000/);
});

test('home offers a brief only where one can be made, and links to an existing brief instead of selling it again', async () => {
  const b = await signedUpCustomer('Kale');
  await db.query("UPDATE tender_desk.open_tenders SET terms=ARRAY['qqqzzz'] WHERE tender_no='MOESCHETQ26006510'");
  await b.post('/checkout/start', { title: 'Audit certification for a museum', agency: 'Agency A', text: '', terms: 'audit' });
  const home = await b.get('/home');
  const row = (no) => home.text.slice(home.text.indexOf(no), home.text.indexOf('</li>', home.text.indexOf(no)));
  assert.doesNotMatch(row('MOESCHETQ26006510'), /Reviewed brief/, 'too few awards: no paid brief on offer');
  await b.post('/checkout', { tender_no: 'RPO000ETQ26000129', terms: 'audit' }).catch(() => {});
  const again = await b.get('/home');
  const owned = await db.query("SELECT 1 FROM tender_desk.brief_requests r JOIN tender_desk.clients c ON c.id=r.client_id WHERE r.tender_no='RPO000ETQ26000129' AND c.name LIKE 'Kale Audit%' AND r.status IN ('requested','drafted','approved')");
  const rpoRow = again.text.slice(again.text.indexOf('RPO000ETQ26000129'), again.text.indexOf('</li>', again.text.indexOf('RPO000ETQ26000129')));
  if (owned.rows.length) assert.match(rpoRow, /View your brief/);
  assert.doesNotMatch(rpoRow, /available for a reviewed brief/, 'whether someone else holds it is not shown');
});

test('the terms note explains the most-specific rule, and a wide band carries a warning', async () => {
  const b = browser('10.0.1.1');
  await b.get('/');
  const check = await b.post('/check', { tender_no: 'MOESCHETQ26006510', terms: 'audit, zzzq' });
  assert.match(check.text, /Matched on "audit", the most specific of these terms with at least five past awards/);
  // With too few awards there is no "matched on" claim to make.
  const none = await b.post('/check', { tender_no: 'RPO000ETQ26000129', terms: 'qqqzzz' });
  assert.doesNotMatch(none.text, /Matched on/);
  assert.match(none.text, /No search terms found five past awards/);
  assert.doesNotMatch(check.text, /A rough guide only/, 'ten audit awards spanning about 2x are not thin');
  const { renderCheck } = await import('../src/customer-view.mjs');
  const wide = renderCheck({ tender: { tender_no: 'X1', title: 'T', agency: 'A' }, reading: { terms: ['t'] }, csrf: 'c',
    check: { status: 'ready', query_used: 't', comparables: [], snapshot: { n: 9, wide_band: true, thin: true, filters: {}, price_band: { low_cents: 100000, median_cents: 400000, high_cents: 900000 } } } });
  assert.match(wide, /A rough guide only: past awards for this kind of work vary a lot. A reviewed brief would advise on bidding and where to aim, but give no dollar range/);
});

test('checkout outside the customer\'s categories needs an explicit tick', async () => {
  const b = await signedUpCustomer('Lime');
  const pasted = { title: 'Event management for a district carnival', agency: 'Agency Q', text: '', terms: 'event management', category: 'events-community' };
  const start = await b.post('/checkout/start', pasted);
  assert.match(start.text, /This tender is outside the categories in your profile/);
  assert.match(start.text, /name="confirm_outside"/);
  const refused = await b.post('/checkout', pasted);
  assert.equal(refused.status, 409);
  assert.match(refused.text, /Tick the box to confirm/);
  const paid = await b.post('/checkout', { ...pasted, confirm_outside: 'yes' });
  assert.equal(paid.status, 303);
});

test('an approved brief reads as a document: verdict block, price row, no Markdown marks or IDs', async () => {
  const b = await signedUpCustomer('Mango');
  const pasted = { title: 'Audit certification for a hospital board', agency: 'Agency A', text: '', terms: 'audit' };
  await b.post('/checkout/start', pasted);
  const paid = await b.post('/checkout', pasted);
  const ref = paid.location.split('/').pop();
  const request = (await db.query('SELECT * FROM tender_desk.brief_requests WHERE reference_number=$1', [Number(ref.slice(3))])).rows[0];
  const admin = desk.admin(adminToken);
  const content = ['## Recommendation', '', 'Do not bid', '', '## Why', '', '- The scope is outside your work.', '', '## Price position', '', 'Below the lower quartile, because the scope is small.', '', '## Your verified projects cited', '', 'None cited.', '', '## Comparable awards', '', '6 awards.', '', '## Limits', '', 'Past awards only.'].join('\n');
  const saved = await admin.saveDraft({ request_id: request.id, recommendation: 'no-bid', content, credentials_cited: [] });
  await admin.reviewBrief({ brief_id: saved.brief_id, decision: 'approved' });
  const page = await b.get(paid.location.slice(base.length));
  assert.doesNotMatch(page.text, /##/);
  assert.match(page.text, /class="verdict nobid"[^>]*>[\s\S]*Do not bid/);
  assert.match(page.text, /Median award/);
  assert.match(page.text, /<h3>Why<\/h3>/);
  assert.doesNotMatch(page.text, /<h3>Comparable awards<\/h3>/);
});

test('after paying, the request page confirms the payment once and shows where the brief is', async () => {
  const b = await signedUpCustomer('Nutmeg');
  const pasted = { title: 'Audit certification for a polytechnic board', agency: 'Agency A', text: '', terms: 'audit' };
  await b.post('/checkout/start', pasted);
  const paid = await b.post('/checkout', pasted);
  const ref = paid.location.split('/').pop();
  const first = await b.get(paid.location.slice(base.length));
  assert.match(first.text, new RegExp(`1 credit spent · ${ref}`));
  assert.match(first.text, /class="steps"[\s\S]*Requested[\s\S]*In review[\s\S]*Brief ready/);
  assert.match(first.text, /aria-current="step"[^>]*>In review/);
  const again = await b.get(paid.location.slice(base.length));
  assert.doesNotMatch(again.text, /Payment received/, 'the confirmation shows once');
  assert.match(again.text, /class="steps"/);
});

test('home status chips use short labels that fit the card', async () => {
  const { renderHome } = await import('../src/customer-view.mjs');
  const html = renderHome({ csrf: 'c', matches: [], refreshedAt: null,
    context: { client: { name: 'C' }, projects: [], requests: [{ reference: 'REQ00009', title: 'T', agency: 'A', status: 'requested' }] } });
  assert.match(html, /<span class="chip progress">In review<\/span>/);
});

test('the credits page shows the balance, sells packs in test mode, and keeps a history', async () => {
  const b = await signedUpCustomer('Olive2');
  const home = await b.get('/home');
  assert.match(home.text, /1 credit/);
  const page = await b.get('/credits');
  assert.match(page.text, /You have 1 credit/);
  assert.match(page.text, /Test mode: no card is charged/);
  assert.match(page.text, /5 credits[\s\S]*S\$119/);
  const bought = await b.post('/credits/buy', { credits: '5' });
  assert.equal(bought.status, 303);
  const after = await b.get('/credits');
  assert.match(after.text, /You have 6 credits/);
  assert.match(after.text, /Bought 5 credits/);
  assert.match(after.text, /Welcome credit/);
});

test('with no credits left, checkout offers to buy credits instead of spending', async () => {
  const b = await signedUpCustomer('Plum');
  const pasted = { title: 'Audit certification for a statutory board', agency: 'Agency A', text: '', terms: 'audit' };
  await b.post('/checkout/start', pasted);
  await b.post('/checkout', pasted);
  const second = await b.post('/checkout/start', { ...pasted, title: 'Audit certification for a town council' });
  assert.doesNotMatch(second.text, /Use 1 credit|Get my free brief/);
  assert.match(second.text, /href="[^"]*\/credits"[^>]*>Buy credits/);
});

test('an approved brief with parts reads as a visual report: range callout, charts, scorecard, questions', async () => {
  const b = await signedUpCustomer('Quince3');
  const pasted = { title: 'Audit certification for a sports council', agency: 'Agency A', text: '', terms: 'audit',
    requirements: 'Bidder must have audited a public body. Must have an accredited auditor on the team.' };
  const start = await b.post('/checkout/start', pasted);
  assert.match(start.text, /name="requirements"/);
  const paid = await b.post('/checkout', pasted);
  const ref = paid.location.split('/').pop();
  const request = (await db.query('SELECT * FROM tender_desk.brief_requests WHERE reference_number=$1', [Number(ref.slice(3))])).rows[0];
  assert.match(request.requirements_text, /accredited auditor/);
  const admin = desk.admin(adminToken);
  const facts = await admin.prepareDraft(request.id);
  assert.match(facts.requirements_text, /accredited auditor/);
  const { checkDraft } = await import('../src/brief-drafting.mjs');
  const checked = checkDraft({ recommendation: 'bid', reasons: ['Your audit work for a polytechnic is the same kind of job.'],
    price_position: { band: 'lower_quartile_to_median', why: 'The scope is ordinary and the buyer is cost-conscious, so stay near the middle.' },
    requirements: [{ requirement: 'Audited a public body', status: 'met', evidence: 'Audit for a polytechnic' }, { requirement: 'Accredited auditor on the team', status: 'gap', evidence: 'Not shown in your profile' }],
    questions: ['Does the board accept a joint bid with an accredited firm?'], risks: ['The board may prefer a past auditor.'], credentials_cited: [] }, facts);
  assert.equal(checked.ok, true, checked.reason);
  const saved = await admin.saveDraft({ request_id: request.id, ...checked.draft });
  assert.equal(saved.outcome, 'allowed', saved.reason);
  await admin.reviewBrief({ brief_id: saved.brief_id, decision: 'approved' });
  const page = (await b.get(paid.location.slice(base.length))).text;
  assert.match(page, /Suggested price range[\s\S]{0,200}S\$\d/);
  assert.match(page, /<svg class="chart"[^>]*aria-label="\d+ comparable awards/);
  assert.match(page, /Who usually wins/);
  assert.match(page, /Awards per year/);
  assert.match(page, /class="scorecard"[\s\S]*1 gap[\s\S]*1 met/, 'gaps come first: they are what could stop the bid');
  assert.ok(page.indexOf('Accredited auditor on the team') < page.indexOf('Audited a public body'), 'a gap is listed before a met requirement');
  assert.ok(page.indexOf('What could stop you') < page.indexOf('Why we say bid'), 'what could stop the bid comes before the reasons');
  assert.match(page, /Ask the agency[\s\S]*joint bid/);
  assert.match(page, /<details[\s\S]*Show the \d+ comparable awards/);
  assert.doesNotMatch(page, /##/);
});

test('right after sign-up the header shows a signed-in state, not Sign in', async () => {
  const b = browser('10.0.2.1');
  await b.get('/signup');
  await b.post('/signup', { email: `fresh-${randomBytes(3).toString('hex')}@sme.example`, password: 'a long password', name: 'Owner' });
  const profile = await b.get('/profile');
  assert.doesNotMatch(profile.text, />Sign in</);
  assert.match(profile.text, />Sign out</);
});

test('a customer can edit their profile and add projects; new projects start unverified', async () => {
  const b = await signedUpCustomer('Rue');
  const form = await b.get('/profile');
  assert.match(form.text, /name="capabilities"[^>]*>[\s\S]*Audit and certification work/);
  assert.match(form.text, /Private-sector projects count/);
  const saved = await b.post('/profile', { name: (/name="name"[^>]*value="([^"]+)"/.exec(form.text) ?? [])[1], capabilities: 'Audit, certification and training.',
    categories: 'other', team_size: '9', max_contract: '800000', project_title_0: 'Training for a hospital board', project_agency_0: 'Private hospital' });
  assert.equal(saved.status, 303);
  const home = await b.get('/home');
  assert.match(home.text, /Profile saved/);
  assert.match(home.text, /Training for a hospital board/);
  const after = await b.get('/profile');
  assert.match(after.text, /value="9"/);
  assert.match(after.text, /name="max_contract"[^>]*value="800,000"/, 'saved amounts come back with commas, like the assistant writes them');
});

test('a sample brief is public, labelled fictional, and linked from the landing page and checkout', async () => {
  const b = browser('10.0.2.2');
  const landing = await b.get('/');
  assert.match(landing.text, /href="[^"]*\/sample"/);
  assert.match(landing.text, /ITQ is an invitation to quote/);
  const sample = await b.get('/sample');
  assert.equal(sample.status, 200);
  assert.match(sample.text, /Sample brief: a fictional example/);
  assert.match(sample.text, /<svg class="chart"/);
  assert.match(sample.text, /Suggested price range/);
});

test('home sorts tenders by closing date and flags those closing within three days', async () => {
  const b = await signedUpCustomer('Sorrel');
  const home = await b.get('/home');
  const closing = [...home.text.matchAll(/closes (\d+ \w+ \d{4})/g)].map((m) => new Date(m[1]).getTime());
  assert.ok(closing.length > 1);
  assert.deepEqual(closing, [...closing].sort((x, y) => x - y), 'soonest closing first');
  const { renderHome } = await import('../src/customer-view.mjs');
  const html = renderHome({ csrf: 'c', refreshedAt: null, context: { client: { name: 'C' }, projects: [], requests: [] },
    matches: [{ tender: { tender_no: 'T1', title: 'T', agency: 'A', closes_at: '2026-11-24T05:00:00Z' }, closesInDays: 2, check: { status: 'insufficient_comparables', snapshot: {} } }] });
  assert.match(html, /class="chip warning">Closes in 2 days/);
});

test('price checks explain median and quartile in plain words', async () => {
  const b = browser('10.0.2.3');
  await b.get('/');
  const check = await b.post('/check', { tender_no: 'RPO000ETQ26000129' });
  assert.match(check.text, /half were above, half below/);
});

test("home does not reveal which tenders another customer holds; checkout still refuses", async () => {
  const b = await signedUpCustomer('Tansy');
  const home = await b.get('/home');
  assert.doesNotMatch(home.text, /Not available for a reviewed brief/);
});

test('a no-bid report shows no suggested range or outlined band', async () => {
  const { renderRequest } = await import('../src/customer-view.mjs');
  const html = renderRequest({ csrf: 'c', company: 'C', awards: [{ tender_no: 'A1', cents: 10000000, description: 'd', agency: 'a', date: '2025-01-01', winner: 'w' }],
    request: { status: 'approved', reference: 'REQ1', title: 'T', agency: 'A', source: 'pasted', recommendation: 'no-bid', price_band: { low_cents: 8000000, median_cents: 10000000, high_cents: 12000000 }, n: 7,
      parts: { recommendation: 'no-bid', n: 7, reasons: ['Outside your trade.'], price_position: null, suggested_range: null, winners: [], requirements: [], questions: [], risks: [], cited: [] } } });
  assert.match(html, /Do not bid/);
  assert.doesNotMatch(html, /Suggested price range|Suggested range/);
});

test('with email verification on, sign-up asks the customer to check their email and opens no session', async () => {
  const fake = fakeNeonAuth({ requireVerification: true });
  const auth = createCustomerAuth({ baseUrl: 'https://auth.example', origin, adminUserId: 'admin-user-0001', fetchImpl: fake.fetchImpl });
  const verifying = createCustomerHandler({ desk, dataset, auth, llm, models: { read: 'r', draft: 'd' }, database, basePath: base, secureCookies: true,
    refresh: async () => {}, now: () => new Date('2026-11-22T02:00:00Z') });
  const page = await verifying(new Request(`${origin}${base}/signup`, { headers: { Origin: origin } }), '/signup');
  const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())[1];
  const cookie = page.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const email = `verify-${randomBytes(3).toString('hex')}@sme.example`;
  const done = await verifying(new Request(`${origin}${base}/signup`, { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, email, password: 'a long password', name: 'Owner' }).toString() }), '/signup');
  assert.equal(done.status, 200);
  const text = await done.text();
  assert.match(text, /Check your email/);
  assert.match(text, new RegExp(email.replace(/[.+]/g, '\\$&')));
  assert.ok(!done.headers.getSetCookie().some((c) => c.startsWith('td_customer=') && !c.includes('Max-Age=0')));
  assert.equal(fake.calls.find((c) => c.path === '/sign-up/email').body.callbackURL, `${origin}${base}/signin`);
});

const reportFor = async (parts, extra = {}) => (await import('../src/customer-view.mjs')).renderRequest({ csrf: 'c', company: 'C',
  awards: [['A1', 10012345, '2021-03-01'], ['A2', 12000000, '2025-06-01'], ['A3', 9000000, '2023-01-01']].map(([tender_no, cents, date]) => ({ tender_no, cents, description: 'd', agency: 'a', date, winner: 'w' })),
  request: { status: 'approved', reference: 'REQ1', title: 'T', agency: 'A', source: 'pasted', recommendation: parts.recommendation, price_band: { low_cents: 8000050, median_cents: 10000000, high_cents: 12000000 }, n: 7,
    parts: { n: 7, reasons: ['r'], price_position: null, suggested_range: null, winners: [], requirements: [], questions: [], risks: [], cited: [], ...parts }, ...extra } });

test('a thin bid report gives no dollar range: it says why and keeps a rough position', async () => {
  const html = await reportFor({ recommendation: 'bid', thin: true, position_text: 'Between the lower quartile and the median',
    price_position: { band: 'lower_quartile_to_median', why: 'Standard scope.' } });
  assert.match(html, /No dollar range/);
  assert.match(html, /Roughly: between the lower quartile and the median/);
  assert.doesNotMatch(html, /Suggested price range/);
});

test('a no-bid report labels the price chart as context only', async () => {
  assert.match(await reportFor({ recommendation: 'no-bid' }), /Past awards, for context only/);
});

test('the report uses whole dollars, says when the awards date from, and how many panel awards were left out', async () => {
  const html = await reportFor({ recommendation: 'no-bid', excluded_panels: 3 });
  assert.doesNotMatch(html.replace(/<style[\s\S]*?<\/style>/g, ''), /S\$[\d,]+\.\d\d/);
  assert.match(html, /These comparable awards date from 2021 to 2025\./);
  // Shared awards make the winner counts add up to more than the awards: the report says so.
  const shared = await reportFor({ recommendation: 'no-bid', n: 6, winners: [{ name: 'A Co', wins: 3 }, { name: 'B Co', wins: 2 }, { name: 'C Co', wins: 2 }] });
  assert.match(shared, /Some awards went to more than one firm, so these counts add up to more than 6\./);
  assert.doesNotMatch(await reportFor({ recommendation: 'no-bid', n: 6, winners: [{ name: 'A Co', wins: 3 }] }), /more than one firm/);
  assert.match(html, /3 panel awards \(one award shared by several firms\) were left out/);
});

test('the report says how many study trips that only named this kind of work were left out', async () => {
  assert.match(await reportFor({ recommendation: 'no-bid', excluded_trips: 2 }), /2 study trips that only name this kind of work in their title were left out/);
  assert.doesNotMatch(await reportFor({ recommendation: 'no-bid' }), /study trip/);
});

test('an approved brief shows every step done, and the sample shows no payment steps', async () => {
  const html = await reportFor({ recommendation: 'no-bid' });
  assert.doesNotMatch(html, /class="current"/);
  assert.match(html, /<li class="done"[^>]*>Brief ready/);
  const { renderSample } = await import('../src/customer-view.mjs');
  assert.doesNotMatch(renderSample({ csrf: 'c' }), /<ol class="steps">/);
});

test('a new customer can paste their company text: the profile form comes back filled in, with their own GeBIZ awards, and nothing is saved yet', async () => {
  const b = browser('10.0.0.21');
  await b.get('/signup');
  await b.post('/signup', { email: `assist-${randomBytes(3).toString('hex')}@sme.example`, password: 'a long password', name: 'Owner' });
  const blank = await b.get('/profile');
  assert.match(blank.text, /Fill this in for me/);
  const filled = await b.post('/profile/assist', { name: 'Auditor 3 Pte Ltd', text: 'We audit public bodies and schools. Team of twelve accountants.' });
  assert.equal(filled.status, 200);
  assert.match(filled.text, /Check everything, then save/);
  assert.doesNotMatch(filled.text, /Fill this in for me/, 'the assistant folds away once it has filled the form');
  assert.match(filled.text, /Fill the form again from text/);
  const none = await b.post('/profile/assist', { name: 'Nobody Known Pte Ltd' });
  assert.match(none.text, /<p class="banner note" role="status">No GeBIZ awards found/);
  // Text read but no awards found: a neutral note that says what was done, never a green success box.
  const readOnly = await b.post('/profile/assist', { name: 'Nobody Known Pte Ltd', text: 'We audit public bodies and schools.' });
  assert.match(readOnly.text, /<p class="banner note" role="status">Filled the form from your text\. No GeBIZ awards found/);
  assert.match(filled.text, /value="Auditor 3 Pte Ltd"/);
  assert.match(filled.text, />Audits for public bodies and schools, run by chartered accountants\.</);
  assert.match(filled.text, /name="project_gebiz_0"[^>]*value="AUD-3"/);
  assert.match(filled.text, /name="project_title_1"[^>]*value="Audit for a polytechnic"/);
  const home = await b.get('/home');
  assert.equal(home.location, `${base}/profile`, 'nothing was saved: there is still no company');
});

test('an existing customer can look up their GeBIZ awards into the add-project slots', async () => {
  const b = await signedUpCustomer('Lookup');
  await db.query("UPDATE tender_desk.clients SET name='Auditor 5' WHERE id=(SELECT client_id FROM tender_desk.customers ORDER BY created_at DESC LIMIT 1)");
  const page = await b.get('/profile');
  assert.match(page.text, /Find my GeBIZ awards/);
  const found = await b.post('/profile/assist', {});
  assert.match(found.text, /name="project_gebiz_0"[^>]*value="AUD-5"/);
  assert.match(found.text, /Found 1 GeBIZ award/);
});

test('checkout lists what would make the brief weak before a credit is spent', async () => {
  const b = await signedUpCustomer('Gappy');
  const start = await b.post('/checkout/start', { title: 'Audit certification for a hospital', agency: 'Agency A', text: '', terms: 'audit' });
  assert.match(start.text, /Before you use your free brief/);
  assert.match(start.text, /None of your projects has been checked yet/);
  assert.match(start.text, /href="[^"]*\/profile"[^>]*>Improve your profile/);
});

async function requestAs(label) {
  const b = await signedUpCustomer(label);
  const pasted = { title: `Audit certification for a council ${randomBytes(3).toString('hex')}`, agency: 'Agency A', text: '', terms: 'audit' };
  await b.post('/checkout/start', pasted);
  const paid = await b.post('/checkout', pasted);
  const ref = paid.location.split('/').pop();
  const request = (await db.query('SELECT * FROM tender_desk.brief_requests WHERE reference_number=$1', [Number(ref.slice(3))])).rows[0];
  return { b, ref, request };
}

test('when the admin asks for more, the customer sees what to add, resubmits for free, and the request goes back into review', async () => {
  const { b, ref, request } = await requestAs('Needy');
  await desk.admin(adminToken).askForInfo({ request_id: request.id, message: 'Add your council audit work with its GeBIZ number.' });
  const home = await b.get('/home');
  assert.match(home.text, /Needs your reply/);
  const page = await b.get(`/requests/${ref}`);
  assert.match(page.text, /We need a bit more before we can advise/);
  assert.match(page.text, /aria-current="step">Needs your reply/);
  assert.match(page.text, /Add your council audit work with its GeBIZ number\./);
  assert.match(page.text, /Reply by \d{1,2} [A-Z][a-z]{2} 2026/);
  assert.match(page.text, /<button class="outline" type="submit">Cancel and get your credit back/);
  assert.match(page.text, /href="[^"]*\/profile"/);
  assert.match(page.text, /action="[^"]*\/requests\/REQ\d+\/resubmit"/);
  assert.match(page.text, /Cancel and get your credit back/);
  const credits = (await b.get('/credits')).text.match(/You have (\d+) credit/)[1];
  const sent = await b.post(`/requests/${ref}/resubmit`, { requirements: 'Must have audited a council.' });
  assert.equal(sent.status, 303);
  assert.equal(sent.location, `${base}/requests/${ref}`);
  const after = await b.get(`/requests/${ref}`);
  assert.match(after.text, /In review/);
  assert.equal((await b.get('/credits')).text.match(/You have (\d+) credit/)[1], credits, 'no credit spent');
  assert.equal((await db.query('SELECT requirements_text FROM tender_desk.brief_requests WHERE id=$1', [request.id])).rows[0].requirements_text, 'Must have audited a council.');
});

test('a waiting request can be cancelled for its credit back', async () => {
  const { b, ref } = await requestAs('Quitter');
  const page = await b.get(`/requests/${ref}`);
  assert.match(page.text, /Cancel and get your credit back/);
  const before = Number((await b.get('/credits')).text.match(/You have (\d+) credit/)[1]);
  const done = await b.post(`/requests/${ref}/cancel`, {});
  assert.equal(done.status, 303);
  assert.equal(Number((await b.get('/credits')).text.match(/You have (\d+) credit/)[1]), before + 1);
  assert.match((await b.get(`/requests/${ref}`)).text, /Cancelled/);
});

test('a declined request says what to do next', async () => {
  const { b, ref, request } = await requestAs('Declined');
  await desk.admin(adminToken).declineRequest({ request_id: request.id, reason: 'The comparable awards are a different trade.' });
  const page = await b.get(`/requests/${ref}`);
  assert.match(page.text, /We could not advise on this tender/);
  assert.match(page.text, /Your credit has been returned/);
  assert.match(page.text, /href="[^"]*\/"[^>]*>Browse open tenders/);
});

test('resubmitting a request that is not waiting on the customer explains why, without crashing', async () => {
  const { b, ref } = await requestAs('Eager');
  const early = await b.post(`/requests/${ref}/resubmit`, {});
  assert.equal(early.status, 409);
  assert.match(early.text, /Only a request we asked you about can be resubmitted/);
});

test('thin evidence shows customers no quartile figures: home, free check and report give the count and a rounded spread', async () => {
  const { renderCheck, renderRequest } = await import('../src/customer-view.mjs');
  const comparables = [10000000, 12000000, 30000000, 50000000, 61000000, 70000000].map((total_awarded_cents, i) => ({ tender_no: `T${i}`, total_awarded_cents }));
  const snapshot = { n: 6, thin: true, wide_band: false, filters: {}, comparables, price_band: { low_cents: 12000000, median_cents: 40000000, high_cents: 61000000 } };
  const check = renderCheck({ tender: { tender_no: 'X1', title: 'T', agency: 'A' }, reading: { terms: ['t'] }, csrf: 'c', check: { status: 'ready', query_used: 't', comparables: [], snapshot } });
  assert.doesNotMatch(check, /Median award|Lower quartile|S\$400,000/);
  assert.match(check, /6 comparable awards, from about S\$100k to S\$700k/);
  const report = renderRequest({ csrf: 'c', company: 'C', awards: comparables.map((c, i) => ({ tender_no: c.tender_no, cents: c.total_awarded_cents, description: 'd', agency: 'a', date: `202${i % 5}-01-01`, winner: 'w' })),
    request: { status: 'approved', reference: 'REQ9', title: 'T', agency: 'A', source: 'pasted', recommendation: 'no-bid', price_band: snapshot.price_band, n: 6,
      parts: { recommendation: 'no-bid', n: 6, thin: true, reasons: ['r'], price_position: null, suggested_range: null, winners: [], requirements: [], questions: [], risks: [], cited: [] } } });
  assert.doesNotMatch(report.replace(/<style[\s\S]*?<\/style>/g, ''), /Median award|Lower quartile|S\$400,000/);
  assert.match(report, /6 comparable awards, from about S\$100k to S\$700k/);
});

test('the credits page sells one credit at S$29 and shows what each pack saves', async () => {
  const b = await signedUpCustomer('Saver');
  const page = await b.get('/credits');
  assert.match(page.text, /<strong>1 credit<\/strong><span class="meta">S\$29<\/span>/);
  assert.match(page.text, /5 credits[\s\S]*?S\$119 · S\$23\.80 a credit · save 18%/);
  assert.match(page.text, /20 credits[\s\S]*?S\$399 · S\$19\.95 a credit · save 31%/);
});

test('checkout shows when the tender closes', async () => {
  const b = await signedUpCustomer('Clock');
  const tender = { tender_no: `CLOCK${randomBytes(3).toString('hex').toUpperCase()}` };
  await db.query(`INSERT INTO tender_desk.open_tenders (tender_no,title,agency,closes_at,gebiz_url,source_feed,category,terms)
    VALUES ($1,'Audit services for a council','Agency A','2026-12-04T05:00:00Z','https://www.gebiz.gov.sg/x','Professional Services','other',$2)`, [tender.tender_no, ['audit']]);
  const page = await b.get(`/checkout?tender=${tender.tender_no}`);
  assert.match(page.text, /<dt>Closes<\/dt><dd>\d{1,2} [A-Z][a-z]{2} 20\d\d/);
});

test('a declined request does not invite asking again for the same tender', async () => {
  const { b, ref, request } = await requestAs('NoRetry');
  await desk.admin(adminToken).declineRequest({ request_id: request.id, reason: 'Different trade.' });
  const page = await b.get(`/requests/${ref}`);
  assert.doesNotMatch(page.text, /Ask for a brief again/);
  assert.equal((page.text.match(/credit has been returned|credit is back/g) ?? []).length, 1);
});

test('the landing box takes a tender number or a title, and names an unknown number', async () => {
  const b = browser('10.0.3.3');
  const landing = await b.get('/');
  assert.match(landing.text, /Closing soon/);
  assert.match(landing.text, /Know the prices before you bid/);
  assert.match(landing.text, /Your first reviewed brief is free/);
  assert.match(landing.text, /Built on [\d,]+ GeBIZ awards/);
  const byNumber = await b.post('/check', { query: 'rpo000etq26000129' });
  assert.equal(byNumber.status, 200);
  assert.match(byNumber.text, /RPO000ETQ26000129/);
  const byTitle = await b.post('/check', { query: 'Audit services for a statutory board' });
  assert.equal(byTitle.status, 200);
  assert.match(byTitle.text, /Free price check/);
  const unknown = await b.post('/check', { query: 'ZZZ000ETQ26999999' });
  assert.equal(unknown.status, 404);
  assert.match(unknown.text, /ZZZ000ETQ26999999 is not among the open GeBIZ tenders/);
});

test('display titles drop GeBIZ boilerplate and capitals but keep acronyms and places', async () => {
  const { displayTitle } = await import('../src/customer-view.mjs');
  assert.equal(displayTitle('INVITATION TO QUOTE FOR THE PROVISION OF CLEANING SERVICES AT TAMAN JURONG FOR MOH'), 'Cleaning services at Taman Jurong for MOH');
  assert.equal(displayTitle('Audit services for a council'), 'Audit services for a council');
});

test('the tender a visitor checked comes back after sign-up and profile, at its checkout', async () => {
  const b = browser('10.0.4.1');
  await b.get('/');
  const check = await b.post('/check', { tender_no: 'RPO000ETQ26000129', terms: 'audit' });
  const href = /href="([^"]*\/signup\?next=[^"]+)"/.exec(check.text)?.[1].replaceAll('&amp;', '&');
  assert.ok(href, 'the free brief button carries the tender');
  const signup = await b.get(href.slice(base.length));
  assert.match(signup.text, /Next: your free brief/);
  assert.match(signup.text, /Audit certification services/);
  assert.match(signup.text, /Your first reviewed brief is free/);
  assert.ok(b.jar.get('td_next'), 'the tender is kept while they sign up');
  const email = `next-${randomBytes(3).toString('hex')}@sme.example`;
  const made = await b.post('/signup', { email, password: 'a long password', name: 'Owner' });
  assert.equal(made.location, `${base}/profile`);
  await b.get('/profile');
  const saved = await b.post('/profile', { name: `Nextco ${randomBytes(3).toString('hex')}`, uen: testUen(), capabilities: 'Audits.', categories: 'other', team_size: '4', max_contract: '300,000' });
  assert.equal(saved.status, 303);
  assert.match(saved.location, new RegExp(`^${base}/checkout\\?tender=RPO000ETQ26000129&terms=audit`));
  const checkout = await b.get(saved.location.slice(base.length));
  assert.equal(checkout.status, 200);
  assert.match(checkout.text, /RPO000ETQ26000129/);
  assert.equal(b.jar.get('td_next'), undefined, 'reaching checkout clears the saved tender');
  // Signing in again later goes home, not back to the old tender.
  assert.equal((await b.post('/signout', {})).status, 303);
  await b.get('/signin');
  assert.equal((await b.post('/signin', { email, password: 'a long password' })).location, `${base}/home`);
});

test('sign-in with a saved tender lands on its checkout; a pasted tender comes back by title', async () => {
  const b = await signedUpCustomer('Yarrow');
  const pasted = `/checkout?${new URLSearchParams({ title: 'Audit certification for a museum board', agency: 'Agency M', terms: 'audit', category: 'other' })}`;
  const page = await b.get(pasted);
  assert.equal(page.status, 200);
  assert.match(page.text, /Audit certification for a museum board/);
  const visitor = browser('10.0.4.2');
  const signin = await visitor.get(`/signin?next=${encodeURIComponent('/checkout?tender=RPO000ETQ26000129')}`);
  assert.equal(signin.status, 200);
  assert.ok(visitor.jar.get('td_next'));
});

test('only a checkout path inside the app is kept as the next page', async () => {
  for (const next of ['https://evil.example/checkout?x=1', '//evil.example', '/home', '/checkout?x=1\\\\evil']) {
    const b = browser('10.0.4.3');
    await b.get(`/signup?next=${encodeURIComponent(next)}`);
    assert.equal(b.jar.get('td_next'), undefined, next);
  }
});

test('long GeBIZ titles split into a headline and labelled facts; short ones stay whole', async () => {
  const { tenderParts } = await import('../src/customer-view.mjs');
  const polyclinic = tenderParts('INVITATION TO QUOTE FOR THE PROVISION OF REGISTERED INSPECTOR (ARCHITECTURAL) CONSULTANCY SERVICES FOR THE PROPOSED 4-STOREY POLYCLINIC AND KIDNEY DIALYSIS CENTRE WITH 1 BASEMENT ON LOT 05141C MK 06 AT TAMAN JURONG, SINGAPORE');
  assert.equal(polyclinic.headline, 'Registered inspector (architectural) consultancy services');
  assert.deepEqual(polyclinic.facts, [{ label: 'For', value: 'Proposed 4-storey polyclinic and kidney dialysis centre with 1 basement' },
    { label: 'At', value: 'Taman Jurong' }, { label: 'Lot', value: '05141C MK 06' }]);
  const audit = tenderParts('Quotation for Provision of Audit Certification Services for a period of 2 years with an option to extend for another year for OFN');
  assert.equal(audit.headline, 'Audit certification services for OFN', 'Title Case becomes sentence case, and a three-letter purpose stays in the headline');
  assert.deepEqual(audit.facts.find((f) => f.label === 'Period'), { label: 'Period', value: '2 years, option to extend another year' });
  assert.deepEqual(tenderParts('Audit certification for a museum board'), { headline: 'Audit certification for a museum board', facts: [] });
});

test('slow forms get a working state from a same-origin script the page policy allows', async () => {
  const b = browser('10.0.4.9');
  const landing = await b.get('/');
  assert.match(landing.text, new RegExp(`<script src="${base}/app.js" defer></script>`));
  assert.match(landing.headers.get('content-security-policy'), /script-src 'self'/);
  const script = await b.get('/app.js');
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type'), /javascript/);
  assert.match(script.text, /Checking prices…/);
});

test('the new-profile form shows two project rows and folds the rest; checkout folds the optional requirements', async () => {
  const b = browser('10.0.4.10');
  await b.get('/signup');
  await b.post('/signup', { email: `light-${randomBytes(3).toString('hex')}@sme.example`, password: 'a long password', name: 'Owner' });
  const blank = await b.get('/profile');
  const fold = blank.text.indexOf('<details class="more-projects"');
  assert.ok(fold > blank.text.indexOf('name="project_title_1"') && fold < blank.text.indexOf('name="project_title_2"'));
  const shopper = await signedUpCustomer('Lightco');
  const tenderNo = `LIGHT${randomBytes(3).toString('hex').toUpperCase()}`;
  await db.query(`INSERT INTO tender_desk.open_tenders (tender_no,title,agency,closes_at,gebiz_url,source_feed,category,terms)
    VALUES ($1,'Audit services for a council','Agency A','2026-12-04T05:00:00Z','https://www.gebiz.gov.sg/x','Professional Services','other',$2)`, [tenderNo, ['audit']]);
  const checkout = await shopper.get(`/checkout?tender=${tenderNo}&terms=audit`);
  assert.match(checkout.text, /<details class="co-reqs"><summary>Add the tender's key requirements \(optional\)<\/summary>/);
});

test('round-two fixes: the sample ends on a next step, ties read as text, the report says who approved it and when', async () => {
  const b = browser('10.0.5.1');
  const sample = await b.get('/sample');
  assert.match(sample.text, /Get a brief like this on your tender/);
  assert.doesNotMatch(sample.text, /Back to home/, 'a signed-out visitor cannot open home');
  assert.match(sample.text, /Reviewed and approved by a person/);
  const tie = await reportFor({ recommendation: 'no-bid', n: 6, winners: [{ name: 'A Co', wins: 2 }, { name: 'B Co', wins: 2 }] }, { approved_at: '2026-11-20T03:00:00Z' });
  assert.match(tie, /No single firm dominates: the top 2 each won 2 of 6\./);
  assert.match(tie, /Reviewed and approved by a person on 20 Nov 2026/);
  const signup = await b.get('/signup');
  assert.equal((signup.text.match(/href="[^"]*\/signup"/g) ?? []).length, 0, 'the sign-up page does not link to itself from the nav');
});

test('a thin check says its caveat once, as text, and its offer does not promise a price', async () => {
  const { renderCheck } = await import('../src/customer-view.mjs');
  const comparables = [10000000, 12000000, 30000000, 50000000, 61000000].map((total_awarded_cents, i) => ({ tender_no: `T${i}`, total_awarded_cents }));
  const html = renderCheck({ tender: { tender_no: 'X1', title: 'T', agency: 'A' }, reading: { terms: ['t'] }, csrf: 'c',
    check: { status: 'ready', query_used: 't', comparables: [], snapshot: { n: 5, thin: true, wide_band: false, filters: {}, comparables, price_band: { low_cents: 12000000, median_cents: 30000000, high_cents: 50000000 } } } });
  assert.equal((html.replace(/<svg[\s\S]*?<\/svg>/g, '').match(/5 comparable awards/g) ?? []).length, 1);
  assert.doesNotMatch(html, /class="banner"/);
  assert.match(html, /whether to aim low or high/);
});
