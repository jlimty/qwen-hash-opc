import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { request } from 'node:http';
import test, { after, before } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { createConsoleServer } from '../src/console.mjs';
import { initializeGovernance } from '../src/governance-db.mjs';
import { createTenderDesk } from '../src/governance.mjs';
import { parseTenderCsv } from '../src/tender-data.mjs';

const dataset = parseTenderCsv('tender_no,tender_description,agency,award_date,tender_detail_status,supplier_name,awarded_amt\n' + [
  ...[1, 2, 3, 4, 5].map((i) => `OLD-${i},Event management services,Agency A,1/${i}/2025,Awarded to Suppliers,Past supplier,${i * 12345678}`),
  ...Array.from({ length: 30 }, (_, i) => `NEW-${i + 1},Event <b>management</b> services,Agency A,1/1/2026,Awarded to Suppliers,Hidden winner,9876543`),
].join('\n'));
const founderToken = randomBytes(32).toString('hex');
let db; let desk; let founder; let server; let port; let sequence = 0;

before(async () => {
  db = await PGlite.create();
  await initializeGovernance(db);
  desk = createTenderDesk({ database: db, dataset, founderToken });
  founder = desk.founder(founderToken);
  server = createConsoleServer({ founder: desk.founder, founderToken, dataset });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  port = server.address().port;
});
after(async () => {
  await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  await db.close();
});

function http({ method = 'GET', path = '/', headers = {}, form } = {}) {
  const body = form ? new URLSearchParams(form).toString() : undefined;
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: {
      ...(body && { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }), ...headers } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
const sameOrigin = () => ({ Origin: `http://127.0.0.1:${port}` });
async function login() {
  const result = await http({ method: 'POST', path: '/login', headers: sameOrigin(), form: { token: founderToken } });
  assert.equal(result.status, 303);
  const cookie = result.headers['set-cookie'].map((c) => c.split(';')[0]).join('; ');
  const page = await http({ path: '/', headers: { Cookie: cookie } });
  return { cookie, csrf: /name="csrf" value="([a-f0-9]{64})"/.exec(page.text)?.[1], page };
}
const flashOf = (response) => (response.headers['set-cookie'] ?? []).map((c) => c.split(';')[0]).find((c) => c.startsWith('td_flash=')) ?? '';
const follow = (session, response) => http({ path: response.headers.location, headers: { Cookie: `${session.cookie}; ${flashOf(response)}` } });
const act = (session, path, extra = {}) => http({ method: 'POST', path, headers: { ...sameOrigin(), Cookie: session.cookie }, form: { csrf: session.csrf, ...extra } });

const profile = (name) => ({ name, capabilities: 'Events', categories: ['events-community'], team_size: 4, max_contract_cents: 100000,
  past_projects: [{ title: 'Festival project', value_cents: 12500000 }] });
async function pendingBrief(content = 'Check scope and capacity before bidding.', cite = false) {
  const suffix = randomUUID().slice(0, 6);
  const a = await founder.createClient(profile(`Amber ${suffix}`));
  const b = await founder.createClient(profile(`Birch ${suffix}`));
  if (cite) await founder.verifyProject({ project_id: a.projects[0].id, verified: true });
  const agentA = await desk.agent((await founder.issueAgentCredential({ role: 'client', client_id: a.client_id })).token);
  const agentB = await desk.agent((await founder.issueAgentCredential({ role: 'client', client_id: b.client_id })).token);
  const tender_no = `NEW-${++sequence}`;
  const pricing = await agentA.invoke('request_pricing', { tender_no, query: 'event management' });
  const conflict = await agentB.invoke('request_pricing', { tender_no, query: 'event management' });
  const brief = await agentA.invoke('submit_brief', { tender_no, stat_id: pricing.stat_id, price_band: pricing.price_band, recommendation: 'bid',
    content, credentials_cited: cite ? [a.projects[0].id] : [] });
  return { a, b, tender_no, pricing, conflict, brief, suffix };
}
const status = async (id) => (await db.query('SELECT status FROM tender_desk.briefs WHERE id=$1', [id])).rows[0].status;

test('requires the founder secret: anonymous visits go to login and wrong secrets get no session', async () => {
  const anonymous = await http({ path: '/' });
  assert.equal(anonymous.status, 303);
  assert.equal(anonymous.headers.location, '/login');
  const wrong = await http({ method: 'POST', path: '/login', headers: sameOrigin(), form: { token: 'a'.repeat(64) } });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers['set-cookie'], undefined);
  assert.doesNotMatch(wrong.text, new RegExp(founderToken));
  const { cookie } = await login();
  const flags = (await http({ method: 'POST', path: '/login', headers: sameOrigin(), form: { token: founderToken } })).headers['set-cookie'][0];
  assert.match(flags, /HttpOnly/);
  assert.match(flags, /SameSite=Strict/);
  assert.match(flags, /Path=\//);
  assert.match(cookie, /^td_session=[a-f0-9]{32}\.\d+\.[a-f0-9]{64}; td_csrf=[a-f0-9]{64}$/);
});

test('sends restrictive security headers and serves no scripts', async () => {
  const { page } = await login();
  const csp = page.headers['content-security-policy'];
  for (const part of ["default-src 'none'", "style-src 'self'", "form-action 'self'", "frame-ancestors 'none'", "base-uri 'none'"]) assert.ok(csp.includes(part), part);
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.equal(page.headers['x-content-type-options'], 'nosniff');
  assert.doesNotMatch(page.text, /<script/i);
  const css = await http({ path: '/console.css' });
  assert.equal(css.status, 200);
  assert.match(css.headers['content-type'], /text\/css/);
});

test('rejects foreign hosts, missing or foreign origins, and missing or wrong CSRF tokens', async () => {
  const session = await login();
  assert.equal((await http({ headers: { Host: 'attacker.example' } })).status, 403);
  const brief = await pendingBrief();
  const path = `/actions/brief/${brief.brief.brief_id}/approve`;
  const noOrigin = await http({ method: 'POST', path, headers: { Cookie: session.cookie }, form: { csrf: session.csrf } });
  assert.equal(noOrigin.status, 403);
  const foreign = await http({ method: 'POST', path, headers: { Cookie: session.cookie, Origin: 'https://attacker.example' }, form: { csrf: session.csrf } });
  assert.equal(foreign.status, 403);
  const missing = await http({ method: 'POST', path, headers: { ...sameOrigin(), Cookie: session.cookie }, form: {} });
  assert.equal(missing.status, 403);
  const wrong = await act({ ...session, csrf: 'b'.repeat(64) }, path);
  assert.equal(wrong.status, 403);
  assert.equal(await status(brief.brief.brief_id), 'pending_approval');
});

test('renders the app shell with sidebar navigation, badges and separate screens', async () => {
  await pendingBrief();
  const { page, cookie } = await login();
  assert.match(page.text, /href="\/" aria-current="page"/);
  assert.match(page.text, /Needs your decision/);
  assert.match(page.text, /Recent activity/);
  assert.equal((page.text.match(/class="count">[1-9]\d*</g) ?? []).length, 3);
  for (const [path, marker] of [['/briefs', 'Waiting for approval'], ['/conflicts', 'asked for pricing on'],
    ['/clients', 'Projects to verify'], ['/backtest', 'Reveal outcome'], ['/audit', 'Requested pricing']]) {
    const screen = await http({ path, headers: { Cookie: cookie } });
    assert.equal(screen.status, 200, path);
    assert.ok(screen.text.includes(marker), `${path}: ${marker}`);
  }
  assert.equal((await http({ path: '/briefs/00000000-0000-4000-8000-000000000000', headers: { Cookie: cookie } })).status, 404);
});

test('shows a pending brief with tender, client, band and escaped agent text', async () => {
  const brief = await pendingBrief('<script>alert(1)</script> & "quoted" S$999.00');
  const { page, cookie } = await login();
  assert.match(page.text, new RegExp(brief.tender_no));
  assert.match(page.text, new RegExp(`Amber ${brief.suffix}`));
  assert.match(page.text, /Review/);
  const detail = await http({ path: `/briefs/${brief.brief.brief_id}`, headers: { Cookie: cookie } });
  assert.equal(detail.status, 200);
  assert.match(detail.text, new RegExp(brief.tender_no));
  assert.match(detail.text, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &quot;quoted&quot;/);
  assert.doesNotMatch(detail.text, /<script>alert|<b>management<\/b>/);
  assert.match(detail.text, /S\$[\d,]+\.\d{2}/);
  assert.match(detail.text, /Human review required/);
  assert.match(detail.text, /not checked/i);
  assert.match(detail.text, /Approve/);
  assert.match(detail.text, /Decline/);
  assert.match(detail.text, /Active pricing hold/);
  assert.match(detail.text, /Cites no projects/);
});

test('the founder can approve and decline briefs, with a visible result and an audit entry', async () => {
  const one = await pendingBrief('Brief one.');
  const two = await pendingBrief('Brief two.');
  const session = await login();
  const approved = await act(session, `/actions/brief/${one.brief.brief_id}/approve`);
  assert.equal(approved.status, 303);
  assert.equal(approved.headers.location, `/briefs/${one.brief.brief_id}`);
  assert.equal(await status(one.brief.brief_id), 'approved');
  const after = await follow(session, approved);
  assert.match(after.text, /Brief approved\./);
  assert.match(after.text, /role="status"/);
  assert.match(after.text, /This brief was approved/);
  const declined = await act(session, `/actions/brief/${two.brief.brief_id}/decline`);
  assert.equal(declined.status, 303);
  assert.equal(await status(two.brief.brief_id), 'declined');
  const audit = (await founder.readConsole()).audit.filter((row) => row.actor === 'founder' && row.action === 'review_brief');
  assert.ok(audit.length >= 2);
});

test('a blocked approval is explained, not hidden', async () => {
  const brief = await pendingBrief('Cites a project.', true);
  await founder.verifyProject({ project_id: brief.a.projects[0].id, verified: false });
  const session = await login();
  const blocked = await act(session, `/actions/brief/${brief.brief.brief_id}/approve`);
  assert.equal(await status(brief.brief.brief_id), 'pending_approval');
  const page = await follow(session, blocked);
  assert.match(page.text, /Blocked · G3/);
  assert.match(page.text, /A cited project is not verified/);
});

test('conflicts name both clients, show no price, and resolve either way', async () => {
  const one = await pendingBrief();
  const session = await login();
  const page = (await http({ path: '/conflicts', headers: { Cookie: session.cookie } })).text;
  assert.match(page, new RegExp(`Birch ${one.suffix}`));
  assert.match(page, new RegExp(`Keep serving Amber ${one.suffix}`));
  assert.match(page, /cannot be moved to a competitor/i);
  const resolved = await act(session, `/actions/conflict/${one.conflict.conflict_id}/serve-holder`);
  assert.equal(resolved.status, 303);
  assert.equal((await db.query('SELECT resolution FROM tender_desk.conflicts WHERE id=$1', [one.conflict.conflict_id])).rows[0].resolution, 'serve_holder');
  const other = await pendingBrief();
  await act(session, `/actions/conflict/${other.conflict.conflict_id}/stop`);
  assert.equal((await db.query('SELECT state FROM tender_desk.pricing_holds WHERE tender_no=$1', [other.tender_no])).rows[0].state, 'stopped');
});

test('projects can be verified and revoked from the console', async () => {
  const brief = await pendingBrief();
  const id = brief.a.projects[0].id;
  const session = await login();
  assert.match((await http({ path: '/clients', headers: { Cookie: session.cookie } })).text, /Festival project/);
  const verifyResponse = await act(session, `/actions/project/${id}/verify`);
  assert.equal(verifyResponse.headers.location, '/clients');
  assert.equal((await follow(session, verifyResponse)).status, 200);
  assert.equal((await db.query('SELECT verified FROM tender_desk.projects WHERE id=$1', [id])).rows[0].verified, true);
  await act(session, `/actions/project/${id}/unverify`);
  assert.equal((await db.query('SELECT verified FROM tender_desk.projects WHERE id=$1', [id])).rows[0].verified, false);
  assert.equal((await act(session, '/actions/project/not-a-uuid/verify')).status, 404);
});

test('the audit log shows plain-language actions with rule IDs, and reading it writes nothing', async () => {
  await pendingBrief();
  const before = (await db.query('SELECT count(*)::int AS n FROM tender_desk.audit_log')).rows[0].n;
  const { page, cookie } = await login();
  await http({ path: '/', headers: { Cookie: cookie } });
  const audit = await http({ path: '/audit', headers: { Cookie: cookie } });
  assert.match(audit.text, /Audit log/);
  assert.match(audit.text, /Escalated · G2/);
  assert.match(audit.text, /Requested pricing/);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM tender_desk.audit_log')).rows[0].n, before);
});

test('same-site form posts keep their Origin header: browsers send "Origin: null" under Referrer-Policy no-referrer, which the Sites gateway rejects', async () => {
  const { page } = await login();
  assert.equal(page.headers['referrer-policy'], 'same-origin');
  assert.equal((await http({ path: '/login' })).headers['referrer-policy'], 'same-origin');
});

test('the local secret console offers no password reset: no link, and the pages are not routable', async () => {
  const page = (await http({ path: '/login' })).text;
  assert.doesNotMatch(page, /Forgot password/);
  for (const path of ['/forgot', '/reset?token=abcdefghijklmnopqrstuvwx']) {
    const response = await http({ path });
    assert.equal(response.status, 303, path);
    assert.equal(response.headers.location, '/login');
  }
});

test('logging out ends the session, and repeated wrong secrets are throttled', async () => {
  const session = await login();
  const out = await act(session, '/logout');
  assert.equal(out.status, 303);
  assert.equal((await http({ path: '/', headers: { Cookie: session.cookie } })).status, 303);
  const results = [];
  for (let i = 0; i < 8; i++) results.push((await http({ method: 'POST', path: '/login', headers: sameOrigin(), form: { token: 'c'.repeat(64) } })).status);
  assert.ok(results.includes(429), results.join());
  assert.equal((await http({ method: 'POST', path: '/login', headers: sameOrigin(), form: { token: founderToken } })).status, 429);
});
