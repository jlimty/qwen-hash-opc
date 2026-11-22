import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const script = fileURLToPath(new URL('../scripts/tender-desk-server.mjs', import.meta.url));

function launch(stateDir, args = []) {
  const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, TENDER_DESK_STATE_DIR: stateDir, TENDER_DESK_PORT: '0', TENDER_DESK_CONSOLE_PORT: '0' } });
  let output = '';
  let errors = '';
  child.stderr.on('data', (chunk) => { errors += chunk; });
  const ready = new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const match = /listening at (http:\/\/127\.0\.0\.1:\d+\/mcp)/.exec(output);
      if (match) resolve(new URL(match[1]));
    });
    child.on('exit', (code) => reject(new Error(`Server exited with ${code}: ${errors}`)));
  });
  let exited = false;
  child.on('exit', () => { exited = true; });
  ready.catch(() => {});
  const stop = () => new Promise((resolve) => {
    if (exited) return resolve();
    child.once('exit', resolve);
    child.kill('SIGINT');
  });
  return { ready, stop, output: () => output, errors: () => errors };
}
async function connect(url, token) {
  const client = new Client({ name: 'cli-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: token } } }));
  return client;
}
const call = async (client, name, args = {}) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

test('launcher seeds fictional clients, protects credential files, persists across restart and never prints credentials', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tender-desk-server-'));
  let server = launch(stateDir, ['--seed-demo']);
  try {
    const url = await server.ready;
    const tokens = {};
    for (const label of ['intake', 'birch']) {
      const file = join(stateDir, 'agent-tokens', `${label}.txt`);
      assert.equal((await stat(file)).mode & 0o777, 0o600);
      assert.equal((await stat(join(stateDir, 'agent-tokens'))).mode & 0o777, 0o700);
      tokens[label] = (await readFile(file, 'utf8')).trim();
      assert.match(tokens[label], /^Bearer [a-f0-9]{64}$/);
    }
    assert.equal(new Set(Object.values(tokens)).size, 2);
    assert.equal((await stat(join(stateDir, 'admin-token.txt'))).mode & 0o777, 0o600);
    const adminSecret = (await readFile(join(stateDir, 'admin-token.txt'), 'utf8')).trim();
    assert.match(adminSecret, /^[a-f0-9]{64}$/);
    const consoleUrl = /Admin console at (http:\/\/127\.0\.0\.1:\d+\/)/.exec(server.output())[1];
    assert.match(await (await fetch(`${consoleUrl}login`)).text(), /Admin sign-in/);
    assert.ok(!server.output().includes(adminSecret));

    const intake = await connect(url, tokens.intake);
    const created = await call(intake, 'create_client', { name: 'Cedar Markets (test)', capabilities: 'Night markets', categories: ['events-community'], team_size: 6, max_contract_cents: 20000000 });
    const server0 = created.connector_config.mcpServers[created.connector_name];
    assert.equal(server0.url, url.href);
    tokens.cedar = server0.headers.Authorization;
    await intake.close();
    const amber = await connect(url, tokens.cedar);
    const context = await call(amber, 'get_client_context');
    assert.equal(context.client.name, 'Cedar Markets (test)');
    const birchContext = await call(await connect(url, tokens.birch), 'get_client_context');
    assert.equal(birchContext.client.past_projects.length, 1);
    const incoming = await call(amber, 'get_incoming_tenders', { category: 'events-community', limit: 1 });
    const tender = incoming.items[0].tender_no;
    assert.equal((await call(amber, 'save_shortlist', { items: [{ tender_no: tender, fit_score: 60, reasons: ['Persisted'] }] })).outcome, 'allowed');
    const pricing = await call(amber, 'request_pricing', { tender_no: tender, query: 'event management' });
    assert.equal(pricing.outcome, 'allowed');
    const birch = await connect(url, tokens.birch);
    assert.equal((await call(amber, 'submit_brief', { tender_no: tender, stat_id: pricing.stat_id, price_band: pricing.price_band, recommendation: 'bid', content: 'Check capacity.' })).outcome, 'allowed');
    const birchPricing = await call(birch, 'request_pricing', { tender_no: tender, query: 'event management' });
    assert.equal(birchPricing.outcome, 'allowed');
    assert.equal((await call(birch, 'submit_brief', { tender_no: tender, stat_id: birchPricing.stat_id, price_band: birchPricing.price_band, recommendation: 'bid', content: 'Check capacity.' })).outcome, 'escalated');
    await amber.close();
    await birch.close();

    const printed = server.output() + server.errors();
    for (const token of Object.values(tokens)) assert.ok(!printed.includes(token.slice(7)));
    await server.stop();

    server = launch(stateDir);
    const restarted = await server.ready;
    const again = await connect(restarted, tokens.cedar);
    assert.equal((await call(again, 'get_client_context')).client.shortlist.length, 1);
    assert.equal((await call(again, 'request_pricing', { tender_no: tender, query: 'event management' })).stat_id, pricing.stat_id);
    await again.close();
  } finally {
    await server.stop().catch(() => {});
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('launcher refuses to reseed over existing credential files', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tender-desk-server-'));
  try {
    let first = launch(stateDir, ['--seed-demo']);
    await first.ready;
    await first.stop();
    const second = launch(stateDir, ['--seed-demo']);
    await assert.rejects(second.ready, /already|exist/i);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('a port clash fails before any seeding state is written', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tender-desk-server-'));
  const blocker = createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  try {
    const child = spawn(process.execPath, [script, '--seed-demo'], { env: { ...process.env, TENDER_DESK_STATE_DIR: stateDir, TENDER_DESK_PORT: String(blocker.address().port), TENDER_DESK_CONSOLE_PORT: '0' } });
    const code = await new Promise((resolve) => child.on('exit', resolve));
    assert.notEqual(code, 0);
    await assert.rejects(stat(join(stateDir, 'agent-tokens', 'amber.txt')));
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
    await rm(stateDir, { recursive: true, force: true });
  }
});
