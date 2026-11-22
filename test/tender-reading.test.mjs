import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keywordTerms, readTender } from '../src/tender-reading.mjs';

test('valid model output is used', async () => {
  const seen = [];
  const llm = async (request) => { seen.push(request); return { terms: ['exhibition design'], category: 'events-community', agency: null }; };
  const result = await readTender({ title: 'Design of a heritage exhibition', agency: 'National Heritage Board' }, { llm, model: 'm' });
  assert.deepEqual(result, { terms: ['exhibition design'], category: 'events-community', agency: 'National Heritage Board', source: 'model' });
  assert.equal(seen[0].model, 'm');
  assert.equal(typeof seen[0].jsonSchema, 'object');
});

test('invalid model output falls back to keywords', async () => {
  const llm = async () => ({ terms: [], category: 'nope' });
  const result = await readTender({ title: 'Conceptualisation & Production of School Corporate Video Clips' }, { llm, model: 'm' });
  assert.equal(result.source, 'keywords');
  assert.ok(result.terms.length > 0);
  assert.ok(result.terms.every((term) => /^[a-z0-9 ]+$/.test(term)));
});

test('a model error falls back to keywords', async () => {
  const result = await readTender({ title: 'Provision of cleaning services for 3 years' }, { llm: async () => { throw new Error('model unavailable'); }, model: 'm' });
  assert.equal(result.source, 'keywords');
  assert.equal(result.category, 'cleaning-facilities');
  assert.deepEqual(result.terms, ['cleaning']);
});

test('gibberish and very long input never throws', async () => {
  const result = await readTender({ title: 'zzzz '.repeat(2500) }, {});
  assert.equal(result.source, 'keywords');
  assert.equal(result.category, 'other');
  const empty = await readTender({ title: '!!!' }, {});
  assert.deepEqual(empty.terms, []);
});

test('keywordTerms drops procurement stopwords', () => {
  assert.deepEqual(keywordTerms('Invitation to quote for the provision of event management services').terms, ['event', 'management']);
});

test('model input is capped at 4000 characters', async () => {
  let user = '';
  await readTender({ title: 'Event', text: 'x'.repeat(10000) }, { llm: async (request) => { user = request.user; throw new Error('x'); }, model: 'm' });
  assert.ok(user.length <= 4300);
});

test('reading asks for a quick answer: reasoning off and a 20-second limit', async () => {
  let request;
  await readTender({ title: 'Event management' }, { llm: async (r) => { request = r; return { terms: ['event management'], category: 'events-community', agency: null }; }, model: 'm' });
  assert.deepEqual(request.reasoning, { enabled: false });
  assert.equal(request.timeoutMs, 20000);
});

test('the reader is told to name the specific kind of work first and avoid umbrella terms', async () => {
  let request;
  await readTender({ title: 'Registered inspector services' }, { llm: async (r) => { request = r; return { terms: ['registered inspector'], category: 'other', agency: null }; }, model: 'm' });
  assert.match(request.system, /most specific kind of work first/);
  assert.match(request.system, /umbrella/);
});
