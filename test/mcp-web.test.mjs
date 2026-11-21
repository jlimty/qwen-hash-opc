import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test, { after, before } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { PGlite } from '@electric-sql/pglite';
import { backtestFromJson, backtestToJson, buildBacktest } from '../src/backtest.mjs';
import { initializeGovernance } from '../src/governance-db.mjs';
import { createTenderDesk } from '../src/governance.mjs';
import { createMcpWebHandler } from '../src/mcp-web.mjs';
import { parseTenderCsv } from '../src/tender-data.mjs';

const dataset = parseTenderCsv('tender_no,tender_description,agency,award_date,tender_detail_status,supplier_name,awarded_amt\n' + [
  ...[1, 2, 3, 4, 5].map((i) => `OLD-${i},Event management services,Agency A,1/${i}/2025,Awarded to Suppliers,Past supplier,${i * 123456}.00`),
  'NEW-1,Event management services,Agency A,1/1/2026,Awarded to Suppliers,Zebra Secret Pte,98765.43',
].join('\n'));
const founderToken = randomBytes(32).toString('hex');
let db; let desk; let founder; let server; let url; let clientToken; let intakeToken;
const clients = [];

before(async () => {
  db = await PGlite.create();
  await initializeGovernance(db);
  const backtest = backtestFromJson(JSON.parse(JSON.stringify(backtestToJson(buildBacktest(dataset), dataset))), dataset);
  desk = createTenderDesk({ database: db, dataset, founderToken, backtest });
  founder = desk.founder(founderToken);
  const created = await founder.createClient({ name: 'Wire Events', capabilities: 'Events', categories: ['events-community'], team_size: 3, max_contract_cents: 100000000, past_projects: [] });
  clientToken = (await founder.issueAgentCredential({ role: 'client', client_id: created.client_id })).token;
  intakeToken = (await founder.issueAgentCredential({ role: 'intake' })).token;
  const handle = createMcpWebHandler({ authenticate: (token) => desk.agent(token) });
  server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(name, value);
    const response = await handle(new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers, body: req.method === 'POST' ? Buffer.concat(chunks) : undefined }));
    const out = {};
    response.headers.forEach((value, name) => { out[name] = value; });
    res.writeHead(response.status, out).end(Buffer.from(await response.arrayBuffer()));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  url = new URL(`http://127.0.0.1:${server.address().port}/mcp`);
});
after(async () => {
  await Promise.all(clients.map((client) => client.close().catch(() => {})));
  await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  await db.close();
});

async function connect(token) {
  const client = new Client({ name: 'mcp-web-test', version: '1.0.0' });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}
const call = async (client, name, args = {}) => {
  const result = await client.callTool({ name, arguments: args });
  return { ...result, data: JSON.parse(result.content[0].text) };
};

test('the official MCP client completes the handshake and sees only its own role tools', async () => {
  const client = await connect(clientToken);
  const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, ['get_client_context', 'get_incoming_tenders', 'get_policies', 'request_pricing', 'save_shortlist', 'search_tenders', 'submit_brief']);
  const intake = (await (await connect(intakeToken)).listTools()).tools.map((tool) => tool.name).sort();
  assert.deepEqual(intake, ['create_client', 'get_policies']);
  const schema = (await client.listTools()).tools.find((tool) => tool.name === 'request_pricing').inputSchema;
  assert.equal(schema.type, 'object');
  assert.ok(schema.properties.tender_no);
  assert.equal(schema.$schema, undefined);
});

test('tools run through governance: client identity, hold-out secrecy and the pricing flow', async () => {
  const client = await connect(clientToken);
  const context = await call(client, 'get_client_context');
  assert.equal(context.data.client.name, 'Wire Events');
  const incoming = await call(client, 'get_incoming_tenders', {});
  assert.equal(incoming.data.items[0].tender_no, 'NEW-1');
  assert.doesNotMatch(JSON.stringify(incoming.data), /Zebra Secret|9876543/);
  const pricing = await call(client, 'request_pricing', { tender_no: 'NEW-1', query: 'event management' });
  assert.equal(pricing.data.outcome, 'allowed');
  assert.equal(pricing.isError, undefined);
});

test('blocked outcomes are flagged as tool errors, and spoofed client_id is rejected and audited', async () => {
  const client = await connect(clientToken);
  const spoof = await call(client, 'get_client_context', { client_id: '00000000-0000-4000-8000-000000000000' });
  assert.equal(spoof.isError, true);
  assert.equal(spoof.data.rule_id, 'G1');
  const unknown = await client.callTool({ name: 'approve_brief', arguments: {} }).catch((error) => error);
  assert.ok(unknown instanceof Error || unknown.isError);
});

test('missing, wrong and founder credentials get 401, and the founder secret is never accepted', async () => {
  for (const authorization of [undefined, 'Bearer nope', `Bearer ${founderToken}`, 'Basic abc']) {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(authorization && { Authorization: authorization }) }, body: '{}' });
    assert.equal(response.status, 401, String(authorization));
  }
  assert.equal((await fetch(url, { method: 'GET', headers: { Authorization: `Bearer ${clientToken}` } })).status, 405);
});

test('malformed JSON-RPC gets protocol errors, not crashes', async () => {
  const send = (body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${clientToken}` }, body });
  assert.equal((await (await send('{nope')).json()).error.code, -32700);
  assert.equal((await (await send('[]')).json()).error.code, -32600);
  assert.equal((await (await send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'nope/nope' }))).json()).error.code, -32601);
  assert.equal((await send(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))).status, 202);
});

test('a precomputed backtest must match the dataset it was built from', () => {
  const json = JSON.parse(JSON.stringify(backtestToJson(buildBacktest(dataset), dataset)));
  assert.throws(() => backtestFromJson({ ...json, dataset_sha256: 'x'.repeat(64) }, dataset), /does not match/);
});

test('an infrastructure failure while authenticating is a 503, never a misleading 401, and is logged without secrets', async () => {
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args.join(' '));
  try {
    const call = (authenticate) => createMcpWebHandler({ authenticate })(new Request('https://x/mcp', { method: 'POST', headers: { Authorization: 'Bearer abc', 'Content-Type': 'application/json' }, body: '{}' }));
    const down = await call(async () => { throw Object.assign(new Error('connect failed to postgres://user:secret@host/db'), { code: 'CONNECT_TIMEOUT' }); });
    assert.equal(down.status, 503);
    assert.equal((await call(async () => { throw new Error('Unauthorized'); })).status, 401);
  } finally { console.error = original; }
  const line = logged.join('\n');
  assert.match(line, /mcp authentication unavailable: Error \[CONNECT_TIMEOUT\]: connect failed to <url>/);
  assert.doesNotMatch(line, /secret|postgres:\/\//);
});
