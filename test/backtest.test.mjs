import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { request } from 'node:http';
import test, { after, before } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { buildBacktest } from '../src/backtest.mjs';
import { createConsoleServer } from '../src/console.mjs';
import { initializeGovernance } from '../src/governance-db.mjs';
import { createTenderDesk } from '../src/governance.mjs';
import { parseTenderCsv } from '../src/tender-data.mjs';

const dataset = parseTenderCsv('tender_no,tender_description,agency,award_date,tender_detail_status,supplier_name,awarded_amt\n' + [
  ...[1, 2, 3, 4, 5].map((i) => `OLD-${i},Event management services,Agency A,1/${i}/2025,Awarded to Suppliers,Past supplier,${i * 123456}.00`),
  'NEW-1,Event management services,Agency A,1/1/2026,Awarded to Suppliers,Zebra Secret Pte,98765.43',
  'NEW-2,Event management services,Agency A,1/1/2026,Awarded to Suppliers,Past supplier,300000.00',
  'NEW-3,Event management services,Agency A,1/1/2026,Awarded to No Suppliers,,0',
  'NEW-4,Lorry rental,Agency Z,1/1/2026,Awarded to Suppliers,Lone Lorry,1000.00',
].join('\n'));
const adminToken = randomBytes(32).toString('hex');
let db; let desk; let admin; let server; let port;

before(async () => {
  db = await PGlite.create();
  await initializeGovernance(db);
  desk = createTenderDesk({ database: db, dataset, adminToken });
  admin = desk.admin(adminToken);
  server = createConsoleServer({ admin: desk.admin, adminToken, dataset });
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
async function login() {
  const result = await http({ method: 'POST', path: '/login', headers: { Origin: `http://127.0.0.1:${port}` }, form: { token: adminToken } });
  const cookie = result.headers['set-cookie'].map((c) => c.split(';')[0]).join('; ');
  const page = await http({ path: '/', headers: { Cookie: cookie } });
  return { cookie, csrf: /name="csrf" value="([a-f0-9]{64})"/.exec(page.text)[1], page };
}
const flashOf = (response) => (response.headers['set-cookie'] ?? []).map((c) => c.split(';')[0]).find((c) => c.startsWith('td_flash=')) ?? '';
const follow = (session, response) => http({ path: response.headers.location, headers: { Cookie: `${session.cookie}; ${flashOf(response)}` } });
const post = (session, path, extra = {}) => http({ method: 'POST', path, headers: { Origin: `http://127.0.0.1:${port}`, Cookie: session.cookie }, form: { csrf: session.csrf, ...extra } });

test('scores only hold-out tenders that have an amount and at least five comparables', () => {
  const backtest = buildBacktest(dataset);
  assert.deepEqual([...backtest.predictions.keys()].sort(), ['NEW-1', 'NEW-2']);
  assert.equal(backtest.scoreable, 2);
  assert.equal(backtest.unscoreable, 2);
  const first = backtest.predictions.get('NEW-1');
  assert.equal(first.tier, 'agency');
  assert.equal(first.n, 5);
  assert.equal(first.incumbent, 'Past supplier');
});

test('hides actual winners and amounts from the console read model until the admin reveals them', async () => {
  const before = await admin.readConsole();
  assert.equal(before.backtest.revealed, 0);
  assert.equal(before.backtest.pending.length, 2);
  const text = JSON.stringify(before.backtest);
  assert.doesNotMatch(text, /Zebra Secret|9876543|30000000|actual/);
  const { page, cookie } = await login();
  assert.match(page.text, /Backtest: <span class="num">0 of 2<\/span> outcomes revealed/);
  const backtestPage = await http({ path: '/backtest', headers: { Cookie: cookie } });
  assert.match(backtestPage.text, /Reveal all 2 remaining outcomes/);
  assert.doesNotMatch(backtestPage.text, /Zebra Secret|98,765\.43|300,000\.00/);
  assert.doesNotMatch(page.text, /Zebra Secret|98,765\.43|300,000\.00/);
});

test('revealing one tender shows the real award, scores it, and is recorded in the append-only audit log', async () => {
  const result = await admin.revealBacktest({ tender_no: 'NEW-1' });
  assert.equal(result.outcome, 'allowed');
  const state = await admin.readConsole();
  assert.equal(state.backtest.revealed, 1);
  assert.equal(state.backtest.rows[0].prediction.actual_suppliers[0], 'Zebra Secret Pte');
  assert.equal(state.backtest.rows[0].in_band, false);
  assert.equal(state.backtest.rows[0].incumbent_won, false);
  assert.doesNotMatch(JSON.stringify(state.backtest.pending), /Zebra|actual/);
  const audit = state.audit.find((row) => row.action === 'reveal_backtest');
  assert.equal(audit.actor, 'admin');
  assert.equal(audit.tender_no, 'NEW-1');
  assert.equal(audit.outcome, 'allowed');
  await assert.rejects(db.query("DELETE FROM tender_desk.audit_log WHERE action='reveal_backtest'"), { code: '55000' });
});

test('blocks revealing a tender that is not a scoreable hold-out tender, and rejects malformed input', async () => {
  for (const tender_no of ['OLD-1', 'NEW-3', 'NEW-4', 'NOPE']) {
    const result = await admin.revealBacktest({ tender_no });
    assert.equal(result.outcome, 'blocked', tender_no);
    assert.equal(result.rule_id, 'G6');
  }
  const malformed = await admin.revealBacktest({ tender_no: 'NEW-2', extra: true });
  assert.equal(malformed.outcome, 'blocked');
  assert.equal(malformed.rule_id, 'VALIDATION');
  assert.equal((await admin.readConsole()).backtest.revealed, 1);
});

test('agent tools never return outcomes, even after the admin reveals them', async () => {
  const client = await admin.createClient({ name: 'Wall Test Events', capabilities: 'Events', categories: ['events-community'], team_size: 3, max_contract_cents: 1000000 });
  const key = await admin.issueAgentCredential({ role: 'client', client_id: client.client_id });
  const agent = await desk.agent(key.token);
  const incoming = JSON.stringify(await agent.invoke('get_incoming_tenders', {}));
  assert.doesNotMatch(incoming, /Zebra Secret|9876543/);
});

test('the console reveal button works over HTTP, then a reveal-all completes the sample with honest rates', async () => {
  const session = await login();
  assert.match(session.page.text, /Revealed|revealed/);
  const missingCsrf = await http({ method: 'POST', path: '/actions/backtest/NEW-2/reveal', headers: { Origin: `http://127.0.0.1:${port}`, Cookie: session.cookie }, form: {} });
  assert.equal(missingCsrf.status, 403);
  const bad = await post(session, '/actions/backtest/NOPE/reveal');
  assert.equal(bad.status, 303);
  assert.equal(bad.headers.location, '/backtest');
  const blocked = await follow(session, bad);
  assert.match(blocked.text, /Blocked · G6/);

  const unconfirmed = await post(session, '/actions/backtest/all/reveal');
  assert.equal(unconfirmed.status, 303);
  assert.equal(unconfirmed.headers.location, '/backtest/reveal-all');
  assert.equal((await admin.readConsole()).backtest.revealed, 1, 'an unconfirmed reveal-all must change nothing');
  const confirmPage = await http({ path: '/backtest/reveal-all', headers: { Cookie: session.cookie } });
  assert.equal(confirmPage.status, 200);
  assert.match(confirmPage.text, /This cannot be undone/);
  assert.match(confirmPage.text, /Yes, reveal all 1/);
  const backtestPage = await http({ path: '/backtest', headers: { Cookie: session.cookie } });
  assert.doesNotMatch(backtestPage.text, /action="\/actions\/backtest\/all\/reveal"/, 'the backtest page must not offer a one-click reveal-all');
  const all = await post(session, '/actions/backtest/all/reveal', { confirm: 'yes' });
  assert.equal(all.status, 303);
  const page = await follow(session, all);
  assert.match(page.text, /Revealed 1 outcomes/);
  assert.match(page.text, /Zebra Secret Pte/);
  assert.match(page.text, /S\$98,765\.43/);
  assert.match(page.text, /S\$300,000\.00/);
  assert.match(page.text, /50%/);
  assert.match(page.text, /by design/);
  assert.doesNotMatch(page.text, /Reveal all/);
  const state = await admin.readConsole();
  assert.equal(state.backtest.band_hits, 1);
  assert.equal(state.backtest.incumbent_hits, 1);
  assert.equal(state.backtest.band_rate, 0.5);
});

test('reveal state survives a restart because it is derived from the audit log', async () => {
  const again = createTenderDesk({ database: db, dataset, adminToken });
  const state = await again.admin(adminToken).readConsole();
  assert.equal(state.backtest.revealed, 2);
  assert.equal(state.backtest.pending.length, 0);
});
