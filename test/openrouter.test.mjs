import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOpenRouterLlm } from '../src/openrouter.mjs';

const key = 'sk-or-test-secret-key';
const reply = (content) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { status: 200 });
const call = { model: 'qwen/qwen3.7-flash', system: 'sys', user: 'usr', name: 'reading', jsonSchema: { type: 'object' } };

test('posts a JSON-schema chat completion to OpenRouter and returns the parsed content', async () => {
  const requests = [];
  const llm = createOpenRouterLlm({ apiKey: key, referer: 'https://site.example', fetchImpl: async (url, init) => { requests.push({ url, init }); return reply({ ok: 1 }); } });
  assert.deepEqual(await llm(call), { ok: 1 });
  assert.equal(requests[0].url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(requests[0].init.headers.Authorization, `Bearer ${key}`);
  assert.equal(requests[0].init.headers['HTTP-Referer'], 'https://site.example');
  const body = JSON.parse(requests[0].init.body);
  assert.equal(body.model, 'qwen/qwen3.7-flash');
  assert.equal(body.response_format.type, 'json_schema');
  assert.equal(body.response_format.json_schema.name, 'reading');
  assert.deepEqual(body.messages.map((m) => m.role), ['system', 'user']);
});

test('retries once after a server error', async () => {
  let calls = 0;
  const llm = createOpenRouterLlm({ apiKey: key, fetchImpl: async () => (++calls === 1 ? new Response('busy', { status: 502 }) : reply({ ok: 2 })) });
  assert.deepEqual(await llm(call), { ok: 2 });
  assert.equal(calls, 2);
});

test('two failures throw model unavailable without leaking the key', async () => {
  let calls = 0;
  const llm = createOpenRouterLlm({ apiKey: key, fetchImpl: async () => { calls++; return new Response(`bad key ${key}`, { status: 500 }); } });
  await assert.rejects(llm(call), (error) => /model unavailable/.test(error.message) && !error.message.includes(key));
  assert.equal(calls, 2);
});

test('unparseable content counts as a failure', async () => {
  const llm = createOpenRouterLlm({ apiKey: key, fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: 'not json' } }] })) });
  await assert.rejects(llm(call), /model unavailable/);
});

test('a missing key is refused at creation', () => {
  assert.throws(() => createOpenRouterLlm({ apiKey: '' }), /API key/);
});

test('the failure says why, without the key', async () => {
  const body = JSON.stringify({ error: { message: `Invalid schema for response_format 'tender_brief': 'format' is not permitted (key ${key})` } });
  const llm = createOpenRouterLlm({ apiKey: key, fetchImpl: async () => new Response(body, { status: 400 }) });
  await assert.rejects(llm(call), (error) => error.message.startsWith('model unavailable: HTTP 400: Invalid schema for response_format')
    && !error.message.includes(key) && error.message.length <= 260);
});

test('a timeout is named as a timeout', async () => {
  const llm = createOpenRouterLlm({ apiKey: key, timeoutMs: 5, fetchImpl: (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason));
  }) });
  const keepAlive = setInterval(() => {}, 1000);
  try { await assert.rejects(llm(call), /model unavailable: timed out after 0s/); } finally { clearInterval(keepAlive); }
});

test('a call can switch reasoning off and set its own timeout', async () => {
  const requests = [];
  const llm = createOpenRouterLlm({ apiKey: key, fetchImpl: async (url, init) => { requests.push(JSON.parse(init.body)); return reply({ ok: 3 }); } });
  await llm({ ...call, reasoning: { enabled: false }, timeoutMs: 20000 });
  assert.deepEqual(requests[0].reasoning, { enabled: false });
  await llm(call);
  assert.equal(requests[1].reasoning, undefined);
});

test('a timed-out call is not retried, so a slow model cannot double the wait', async () => {
  let calls = 0;
  const llm = createOpenRouterLlm({ apiKey: key, fetchImpl: (url, init) => { calls++; return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))); } });
  const keepAlive = setInterval(() => {}, 1000);
  try { await assert.rejects(llm({ ...call, timeoutMs: 5 }), /timed out/); } finally { clearInterval(keepAlive); }
  assert.equal(calls, 1);
});
