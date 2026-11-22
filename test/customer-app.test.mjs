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

test('checkout spends one credit, and paying twice creates one request', async () => {
  const b = await signedUpCustomer('Birch');
  const checkout = await b.get('/checkout?tender=RPO000ETQ26000129');
  assert.equal(checkout.status, 200);
  assert.match(checkout.text, /Uses 1 credit · you have 1/);
  assert.match(checkout.text, /Use 1 credit/);
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
  assert.match(checkout.text, /Tender Desk already advises a client on this tender\./);
  assert.doesNotMatch(checkout.text, /Use 1 credit/);
  assert.doesNotMatch(checkout.text, /Birch/);
});

test('a pasted tender goes through checkout too', async () => {
  const b = await signedUpCustomer('Dahlia');
  const start = await b.post('/checkout/start', { title: 'Event management for a heritage week', agency: 'Agency Q', text: 'Run the events.', terms: 'event management' });
  assert.equal(start.status, 200);
  assert.match(start.text, /Use 1 credit/);
  const paid = await b.post('/checkout', { title: 'Event management for a heritage week', agency: 'Agency Q', text: 'Run the events.', terms: 'event management', confirm_outside: 'yes' });
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

test('a too-few check does not offer a brief, and checkout with such terms hides the pay button', async () => {
  const b = await signedUpCustomer('Hazel');
  const thin = await b.post('/check', { tender_no: 'MOESCHETQ26006510', terms: 'qqqzzz' });
  assert.doesNotMatch(thin.text, /Ask for a reviewed brief/);
  assert.match(thin.text, /A reviewed brief needs at least five comparable awards/);
  const checkout = await b.get('/checkout?tender=MOESCHETQ26006510&terms=qqqzzz');
  assert.doesNotMatch(checkout.text, /Use 1 credit/);
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
  const median = /<span class="big">(S\$[\d,.]+)<\/span><span class="label">Median award/.exec(seen.text)?.[1];
  const start = await b.post('/checkout/start', { ...pasted, terms: 'event management', category: 'other' });
  assert.match(start.text, /Use 1 credit/);
  const paid = await b.post('/checkout', { ...pasted, terms: 'event management', category: 'other' });
  assert.equal(paid.status, 303);
  const row = (await db.query("SELECT s.snapshot FROM tender_desk.brief_requests r JOIN tender_desk.stats_snapshots s ON s.stat_id=r.stat_id AND s.client_id=r.client_id WHERE r.title=$1", [pasted.title])).rows[0];
  const { formatSgd } = await import('../src/brief-risk.mjs');
  assert.equal(formatSgd(row.snapshot.price_band.median_cents), median);
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
  await b.post('/profile', { name: `Nocheck ${randomBytes(3).toString('hex')}`, capabilities: 'Audit.', categories: 'other', team_size: '2', max_contract: '100000', project_title_0: 'Unchecked audit' });
  const start = await b.post('/checkout/start', { title: 'Audit certification for a hospital', agency: 'Agency A', text: '', terms: 'audit' });
  assert.match(start.text, /None of your projects has been checked yet/);
  assert.match(start.text, /Use 1 credit/);
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

test('home offers a brief only where one can be made, and links to an existing brief instead of selling it again', async () => {
  const b = await signedUpCustomer('Kale');
  await db.query("UPDATE tender_desk.open_tenders SET terms=ARRAY['qqqzzz'] WHERE tender_no='MOESCHETQ26006510'");
  await b.post('/checkout/start', { title: 'Audit certification for a museum', agency: 'Agency A', text: '', terms: 'audit' });
  const home = await b.get('/home');
  const row = (no) => home.text.slice(home.text.indexOf(no), home.text.indexOf('</li>', home.text.indexOf(no)));
  assert.doesNotMatch(row('MOESCHETQ26006510'), /Reviewed brief/, 'too few awards: no paid brief on offer');
  await b.post('/checkout', { tender_no: 'RPO000ETQ26000129', terms: 'audit' }).catch(() => {});
  const again = await b.get('/home');
  const owned = await db.query("SELECT 1 FROM tender_desk.brief_requests r JOIN tender_desk.customers c ON c.client_id=r.client_id WHERE r.tender_no='RPO000ETQ26000129'");
  assert.match(again.text.slice(again.text.indexOf('RPO000ETQ26000129'), again.text.indexOf('</li>', again.text.indexOf('RPO000ETQ26000129'))),
    owned.rows.length ? /View your brief|already advises a client/ : /already advises a client/);
});

test('the terms note explains the most-specific rule, and a wide band carries a warning', async () => {
  const b = browser('10.0.1.1');
  await b.get('/');
  const check = await b.post('/check', { tender_no: 'MOESCHETQ26006510', terms: 'audit, zzzq' });
  assert.match(check.text, /Matched on "audit", the most specific of these terms with at least five past awards/);
  assert.doesNotMatch(check.text, /Wide range/, 'the audit awards span about 2x');
  const { renderCheck } = await import('../src/customer-view.mjs');
  const wide = renderCheck({ tender: { tender_no: 'X1', title: 'T', agency: 'A' }, reading: { terms: ['t'] }, csrf: 'c',
    check: { status: 'ready', query_used: 't', comparables: [], snapshot: { n: 9, wide_band: true, filters: {}, price_band: { low_cents: 100000, median_cents: 400000, high_cents: 900000 } } } });
  assert.match(wide, /Wide range: past awards for this kind of work vary a lot, so treat it as a rough guide/);
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
  assert.match(first.text, /class="steps"[\s\S]*Paid[\s\S]*In review[\s\S]*Brief ready/);
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
  assert.match(page.text, /5 credits[\s\S]*S\$49\.50/);
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
  assert.doesNotMatch(second.text, /Use 1 credit/);
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
  assert.match(page, /class="scorecard"[\s\S]*1 met[\s\S]*1 gap/);
  assert.match(page, /Accredited auditor on the team/);
  assert.match(page, /Questions to ask the agency[\s\S]*joint bid/);
  assert.match(page, /<details[\s\S]*Show the \d+ comparable awards/);
  assert.doesNotMatch(page, /##/);
});
