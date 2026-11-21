import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { request } from 'node:http';
import test, { after, before } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { PGlite } from '@electric-sql/pglite';
import { initializeGovernance } from '../src/governance-db.mjs';
import { createTenderDesk } from '../src/governance.mjs';
import { createTenderDeskServer } from '../src/mcp-business.mjs';
import { parseTenderCsv } from '../src/tender-data.mjs';

const dataset = parseTenderCsv('tender_no,tender_description,agency,award_date,tender_detail_status,supplier_name,awarded_amt\n' + [
  ...[1, 2, 3, 4, 5].map((i) => `OLD-${i},Event management services,Agency A,1/${i}/2025,Awarded to Suppliers,Historical supplier,${i * 100}`),
  ...Array.from({ length: 12 }, (_, i) => `NEW-${i + 1},Event management services,Agency A,1/1/2026,Awarded to Suppliers,Hidden winner,9876543`),
].join('\n'));
const founderToken = randomBytes(32).toString('hex');
let db; let desk; let founder; let server; let url; let sequence = 0;
const clients = [];

before(async () => {
  db = await PGlite.create();
  await initializeGovernance(db);
  desk = createTenderDesk({ database: db, dataset, founderToken });
  founder = desk.founder(founderToken);
  server = createTenderDeskServer({ authenticate: desk.agent });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  url = new URL(`http://127.0.0.1:${server.address().port}/mcp`);
});
after(async () => {
  await Promise.all(clients.map((client) => client.close()));
  await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  await db.close();
});

const profile = (name) => ({ name, capabilities: 'Events', categories: ['events-community'], team_size: 4, max_contract_cents: 100000,
  past_projects: [{ title: 'Verified festival' }] });
async function provision() {
  const suffix = randomUUID().slice(0, 8);
  const a = await founder.createClient(profile(`Amber ${suffix}`));
  const b = await founder.createClient(profile(`Birch ${suffix}`));
  return { a, b, keyA: await founder.issueAgentCredential({ role: 'client', client_id: a.client_id }),
    keyB: await founder.issueAgentCredential({ role: 'client', client_id: b.client_id }), tender_no: `NEW-${++sequence}` };
}
async function connect(token) {
  const client = new Client({ name: 'tender-desk-business-test', version: '1.0.0' });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}
const call = async (client, name, args = {}) => {
  const result = await client.callTool({ name, arguments: args });
  return { ...result, data: JSON.parse(result.content[0].text) };
};
function raw({ method = 'POST', headers = {}, body = method === 'POST' ? '{}' : undefined, target = url } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(target, { method, headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('requires a stored agent credential: missing, wrong, founder and revoked tokens get 401', async () => {
  const c = await provision();
  for (const method of ['GET', 'POST', 'DELETE']) {
    for (const authorization of [undefined, 'Bearer wrong', `Bearer ${founderToken}`, `Basic ${c.keyA.token}`]) {
      const result = await raw({ method, headers: authorization ? { Authorization: authorization } : {} });
      assert.equal(result.status, 401);
      assert.ok(!result.text.includes(founderToken));
    }
  }
  assert.equal((await raw({ target: new URL(`${url}?token=${c.keyA.token}`) })).status, 401);
  await founder.revokeAgentCredential({ credential_id: c.keyA.credential_id });
  assert.equal((await raw({ headers: { Authorization: `Bearer ${c.keyA.token}` } })).status, 401);
});

test('rejects foreign hosts, foreign origins, unknown paths and unsupported methods', async () => {
  const c = await provision();
  const auth = { Authorization: `Bearer ${c.keyA.token}` };
  assert.equal((await raw({ headers: { ...auth, Host: 'attacker.example' } })).status, 403);
  assert.equal((await raw({ headers: { ...auth, Origin: 'https://attacker.example' } })).status, 403);
  assert.equal((await raw({ headers: auth, target: new URL('/other', url) })).status, 404);
  assert.equal((await raw({ method: 'GET', headers: auth })).status, 405);
  assert.equal((await raw({ method: 'DELETE', headers: auth })).status, 405);
  assert.equal((await raw({ headers: { ...auth, }, body: 'x'.repeat(300000) })).status, 413);
});

test('each connector sees only the tools of its credential and no identity or founder fields', async () => {
  const c = await provision();
  const agent = await connect(c.keyA.token);
  const { tools } = await agent.listTools();
  const names = tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, ['get_client_context', 'get_incoming_tenders', 'get_policies', 'request_pricing', 'save_shortlist', 'search_tenders', 'submit_brief']);
  for (const tool of tools) {
    assert.ok(tool.description.length > 20);
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal('client_id' in tool.inputSchema.properties, false);
  }
  const intake = await connect((await founder.issueAgentCredential({ role: 'intake' })).token);
  assert.deepEqual((await intake.listTools()).tools.map((tool) => tool.name).sort(), ['create_client', 'get_policies']);
});

test('an agent can only act as its own client, and spoof attempts are audited without raw input', async () => {
  const c = await provision();
  const agentA = await connect(c.keyA.token);
  const own = await call(agentA, 'get_client_context');
  assert.equal(own.data.client.id, c.a.client_id);
  assert.notEqual(own.isError, true);
  const spoof = await call(agentA, 'get_client_context', { client_id: c.b.client_id, note: 'sensitive-http-marker' });
  assert.equal(spoof.isError, true);
  assert.equal(spoof.data.rule_id, 'G1');
  assert.doesNotMatch(JSON.stringify(spoof.data), new RegExp(c.b.client_id));
  const missing = await call(agentA, 'approve_brief', { brief_id: randomUUID() }).catch((error) => ({ error }));
  assert.ok(missing.error || missing.isError);
  const audit = JSON.stringify((await founder.readConsole()).audit);
  assert.match(audit, /G1/);
  assert.doesNotMatch(audit, /sensitive-http-marker/);
});

test('competing clients over HTTP: one priced, one escalated with no price or holder identity', async () => {
  const c = await provision();
  const [agentA, agentB] = [await connect(c.keyA.token), await connect(c.keyB.token)];
  const args = { tender_no: c.tender_no, query: 'event management' };
  const [first, second] = await Promise.all([call(agentA, 'request_pricing', args), call(agentB, 'request_pricing', args)]);
  const outcomes = [first.data.outcome, second.data.outcome].sort();
  assert.deepEqual(outcomes, ['allowed', 'escalated']);
  const escalated = [first, second].find((r) => r.data.outcome === 'escalated');
  assert.doesNotMatch(JSON.stringify(escalated.data), /price_band|stat_id|low_cents|Amber|Birch|client_id/);
  const allowed = [first, second].find((r) => r.data.outcome === 'allowed');
  assert.doesNotMatch(JSON.stringify(allowed.data), /comparables|top_suppliers|likely_incumbent|Historical supplier/);
});

test('the full agent journey works through MCP and ends pending founder approval', async () => {
  const c = await provision();
  const agent = await connect(c.keyA.token);
  const incoming = await call(agent, 'get_incoming_tenders', { limit: 3 });
  assert.equal(incoming.data.items.length, 3);
  assert.doesNotMatch(JSON.stringify(incoming.data), /Hidden winner|9876543|awarded/);
  assert.equal((await call(agent, 'save_shortlist', { items: [{ tender_no: c.tender_no, fit_score: 70, reasons: ['Capability match'] }] })).data.outcome, 'allowed');
  const pricing = await call(agent, 'request_pricing', { tender_no: c.tender_no, query: 'event management' });
  const brief = await call(agent, 'submit_brief', { tender_no: c.tender_no, stat_id: pricing.data.stat_id, price_band: pricing.data.price_band,
    recommendation: 'bid', content: 'Check scope and capacity before bidding.', credentials_cited: [] });
  assert.equal(brief.data.status, 'pending_approval');
  const forged = await call(agent, 'submit_brief', { tender_no: c.tender_no, stat_id: pricing.data.stat_id, price_band: { ...pricing.data.price_band, low_cents: 1 },
    recommendation: 'bid', content: 'Forged.', credentials_cited: [] });
  assert.equal(forged.isError, true);
  assert.equal(forged.data.rule_id, 'G4');
});

test('tool failures do not leak internal details', async () => {
  const c = await provision();
  const agent = await connect(c.keyA.token);
  const result = await agent.callTool({ name: 'request_pricing', arguments: { tender_no: 'NEW-1', query: 'x'.repeat(5000) } });
  assert.equal(result.isError, true);
  assert.doesNotMatch(result.content[0].text, /at .*\.mjs|node_modules|SELECT |tender_desk\./);
});

test('the server module receives only the authentication function, never founder actions', () => {
  assert.throws(() => createTenderDeskServer({ desk }), /authenticate/i);
});

test('chunked bodies without Content-Length are also capped', async () => {
  const c = await provision();
  const result = await new Promise((resolve, reject) => {
    const req = request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.keyA.token}`, Accept: 'application/json, text/event-stream', 'Transfer-Encoding': 'chunked' } }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', (error) => resolve({ status: error.code }));
    for (let i = 0; i < 40; i++) req.write('x'.repeat(10000));
    req.end();
  });
  assert.ok([413, 'ECONNRESET', 'EPIPE'].includes(result.status), `got ${result.status}`);
});

test('only the exact /mcp path is served', async () => {
  const c = await provision();
  const headers = { Authorization: `Bearer ${c.keyA.token}` };
  for (const path of ['//evil.example/mcp', '/mcp/', '/mcp?x=1']) {
    const result = await raw({ headers, target: Object.assign(new URL(url), { pathname: '/' }), body: '{}' }).catch(() => null);
    assert.ok(result);
    const status = await new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: url.port, path, method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject);
      req.end('{}');
    });
    assert.equal(status, 404, path);
  }
});

test('local Origins are accepted, and intake tools carry no client identity field', async () => {
  const c = await provision();
  const origin = `http://127.0.0.1:${url.port}`;
  const auth = { Authorization: `Bearer ${c.keyA.token}`, Origin: origin, Accept: 'application/json, text/event-stream' };
  const init = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  assert.equal((await raw({ headers: auth, body: init })).status, 200);
  const intake = await connect((await founder.issueAgentCredential({ role: 'intake' })).token);
  const create = (await intake.listTools()).tools.find((tool) => tool.name === 'create_client');
  assert.equal('client_id' in create.inputSchema.properties, false);
});

test('a connected client loses access immediately when its credential is revoked', async () => {
  const c = await provision();
  const agent = await connect(c.keyA.token);
  assert.equal((await call(agent, 'get_client_context')).data.outcome, 'allowed');
  await founder.revokeAgentCredential({ credential_id: c.keyA.credential_id });
  await assert.rejects(call(agent, 'get_client_context'));
});

test('a flood of bad credentials writes at most one aggregated audit row', async () => {
  const before = (await db.query("SELECT count(*)::int AS n FROM tender_desk.audit_log WHERE actor='unauthenticated'")).rows[0].n;
  await Promise.all(Array.from({ length: 40 }, (_, i) => raw({ headers: { Authorization: `Bearer flood${i}` } })));
  const after = (await db.query("SELECT count(*)::int AS n FROM tender_desk.audit_log WHERE actor='unauthenticated'")).rows[0].n;
  assert.ok(after - before <= 1, `wrote ${after - before} rows`);
});

test('tool descriptions disclose side effects and tools carry annotations', async () => {
  const c = await provision();
  const { tools } = await (await connect(c.keyA.token)).listTools();
  const pricing = tools.find((tool) => tool.name === 'request_pricing');
  assert.match(pricing.description, /exclusive/i);
  assert.match(pricing.description, /confirm/i);
  assert.equal(pricing.annotations.readOnlyHint, false);
  assert.equal(tools.find((tool) => tool.name === 'get_incoming_tenders').annotations.readOnlyHint, true);
});
