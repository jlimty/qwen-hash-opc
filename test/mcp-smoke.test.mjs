import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { request } from 'node:http';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createProbeServer } from '../src/mcp-smoke.mjs';

async function startProbe(t) {
  const token = randomBytes(32).toString('hex');
  const calls = [];
  const server = createProbeServer({ token, onHealthCheck: (result) => calls.push(result) });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const url = new URL(`http://127.0.0.1:${server.address().port}/mcp`);
  return { server, token, calls, url };
}

function sendRequest(url, { method = 'POST', headers = {}, body = method === 'POST' ? '{}' : undefined } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function connectProbe(t, probe) {
  const client = new Client({ name: 'tender-desk-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(probe.url, {
    requestInit: { headers: { Authorization: `Bearer ${probe.token}` } },
  });
  t.after(() => client.close());
  await client.connect(transport);
  return client;
}

test('refuses to start without a nonempty secret', () => {
  for (const token of [undefined, '', '   ']) {
    assert.throws(() => createProbeServer({ token }), /token/i);
  }
});

test('rejects missing and incorrect bearer credentials on every MCP method', async (t) => {
  const probe = await startProbe(t);
  for (const method of ['GET', 'POST', 'DELETE']) {
    for (const authorization of [undefined, 'Bearer incorrect-token', `Basic ${probe.token}`]) {
      const headers = authorization ? { Authorization: authorization } : {};
      const result = await sendRequest(probe.url, { method, headers });
      assert.equal(result.status, 401, `${method} must require the correct bearer token`);
      assert.match(result.headers['www-authenticate'], /^Bearer /);
      assert.ok(!result.text.includes(probe.token));
    }
  }
  assert.equal(probe.calls.length, 0);
});

test('does not accept a token from the URL', async (t) => {
  const probe = await startProbe(t);
  const url = new URL(probe.url);
  url.searchParams.set('token', probe.token);
  const result = await sendRequest(url);
  assert.equal(result.status, 401);
});

test('rejects unexpected hosts and browser origins even with valid credentials', async (t) => {
  const probe = await startProbe(t);
  for (const extra of [{ Host: 'untrusted.invalid' }, { Origin: 'https://untrusted.invalid' }]) {
    const result = await sendRequest(probe.url, {
      headers: { Authorization: `Bearer ${probe.token}`, ...extra },
    });
    assert.equal(result.status, 403);
  }
});

test('initializes with the official MCP client and exposes only health_check', async (t) => {
  const probe = await startProbe(t);
  const client = await connectProbe(t, probe);
  assert.equal(client.getServerVersion().name, 'tender-desk-smoke');
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name), ['health_check']);
  assert.equal(tools[0].annotations.readOnlyHint, true);
});

test('health_check echoes a fresh nonce and records a secret-free call receipt', async (t) => {
  const probe = await startProbe(t);
  const client = await connectProbe(t, probe);
  const nonce = randomBytes(8).toString('hex');
  const before = Date.now();
  const result = await client.callTool({ name: 'health_check', arguments: { nonce } });
  assert.ok(!result.isError);
  const data = JSON.parse(result.content[0].text);
  assert.equal(data.status, 'ok');
  assert.equal(data.service, 'tender-desk-smoke');
  assert.equal(data.nonce, nonce);
  assert.ok(Date.parse(data.checked_at) >= before);
  assert.ok(Date.parse(data.checked_at) <= Date.now());
  assert.deepEqual(probe.calls, [data]);
  assert.ok(!JSON.stringify({ result, calls: probe.calls }).includes(probe.token));
});

test('rejects missing, oversized, and multiline nonces without invoking the tool', async (t) => {
  const probe = await startProbe(t);
  const client = await connectProbe(t, probe);
  for (const args of [{}, { nonce: '' }, { nonce: 'a'.repeat(65) }, { nonce: 'fake\nlog' }]) {
    const result = await client.callTool({ name: 'health_check', arguments: args });
    assert.equal(result.isError, true);
  }
  assert.equal(probe.calls.length, 0);
});

test('does not expose admin actions or filesystem tools', async (t) => {
  const probe = await startProbe(t);
  const client = await connectProbe(t, probe);
  for (const name of ['approve_brief', 'read_file']) {
    const result = await client.callTool({ name, arguments: {} });
    assert.equal(result.isError, true);
  }
  assert.equal(probe.calls.length, 0);
});

test('a malformed JSON request does not stop subsequent tool calls', async (t) => {
  const probe = await startProbe(t);
  const result = await sendRequest(probe.url, {
    headers: {
      Authorization: `Bearer ${probe.token}`,
      Accept: 'application/json, text/event-stream',
    },
    body: '{',
  });
  assert.equal(result.status, 400);
  const client = await connectProbe(t, probe);
  const health = await client.callTool({ name: 'health_check', arguments: { nonce: 'still-alive' } });
  assert.ok(!health.isError);
});
