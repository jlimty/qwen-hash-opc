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
