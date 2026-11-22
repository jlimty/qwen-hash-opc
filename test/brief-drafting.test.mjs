import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeRiskFacts, formatSgd } from '../src/brief-risk.mjs';
import { briefLimits, composeBrief, draftBrief } from '../src/brief-drafting.mjs';

const verified = '11111111-1111-4111-8111-111111111111';
const band = { low_cents: 20000000, median_cents: 30000000, high_cents: 50000000 };
const facts = {
  tender: { tender_no: 'LIVE1', title: 'Event management for a festival', agency: 'Agency A', closes_at: '2026-12-04T05:00:00.000Z', category: 'events-community' },
  snapshot: { status: 'ready', n: 23, price_band: band, top_agencies: [{ name: 'Agency A', contracts: 9 }], top_suppliers: [{ name: 'Supplier X', wins: 3 }] },
  query_used: 'event management',
  client: { name: 'Aster Events', capabilities: 'Events', team_size: 8, max_contract_cents: 50000000, categories: ['events-community'] },
  verifiedProjects: [{ id: verified, title: 'Annual ministry event', agency: 'Agency A', value_cents: 200000 }],
  fit: { category_match: true, within_capacity: true, related_projects: 1 },
};
const clean = { recommendation: 'bid', reasons: ['The scope matches your past ministry event.', 'The agency buys this often.'],
  price_position: 'Price between the lower quartile and the median: the scope is standard and the team is small.', credentials_cited: [verified] };
const llmReturning = (value) => async () => value;

test('a clean draft is composed with code-written figures and passes the figure check', async () => {
  const result = await draftBrief(facts, { llm: llmReturning(clean), model: 'm' });
  assert.equal(result.ok, true);
  assert.equal(result.draft.recommendation, 'bid');
  assert.deepEqual(result.draft.credentials_cited, [verified]);
  const content = result.draft.content;
  for (const heading of ['Recommendation', 'Why', 'Price position', 'Your verified projects cited', 'Comparable awards', 'Limits']) assert.match(content, new RegExp(`## ${heading}`));
  assert.ok(content.includes(formatSgd(band.median_cents)));
  assert.ok(content.includes('Annual ministry event'));
  assert.ok(content.includes(briefLimits));
  const risk = computeRiskFacts({ n: 23, band, maxContractCents: 50000000, content, citedCount: 1, verifiedProjectCount: 2, priorBriefCount: 1 });
  assert.ok(!risk.facts.some((fact) => fact.code === 'unmatched_numbers'), JSON.stringify(risk.facts));
});

test('a draft citing an unverified project is refused', async () => {
  const result = await draftBrief(facts, { llm: llmReturning({ ...clean, credentials_cited: ['22222222-2222-4222-8222-222222222222'] }), model: 'm' });
  assert.deepEqual(result, { ok: false, reason: 'Draft cited a project that is not verified.' });
});

test('a draft inventing a figure is refused', async () => {
  const result = await draftBrief(facts, { llm: llmReturning({ ...clean, reasons: ['Similar work went for S$123,456 last year.'] }), model: 'm' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /^Draft contained figures not in the comparables: /);
  assert.match(result.reason, /123,456/);
});

test('model failure or malformed output returns a redraftable reason', async () => {
  assert.deepEqual(await draftBrief(facts, { llm: async () => { throw new Error('model unavailable'); }, model: 'm' }),
    { ok: false, reason: 'The model was unavailable. Try Redraft.' });
  assert.deepEqual(await draftBrief(facts, { llm: llmReturning({ recommendation: 'maybe' }), model: 'm' }),
    { ok: false, reason: 'The model returned an unusable draft. Try Redraft.' });
});

test('no snapshot band means no draft', async () => {
  const result = await draftBrief({ ...facts, snapshot: { status: 'insufficient_comparables', n: 2 } }, { llm: llmReturning(clean), model: 'm' });
  assert.deepEqual(result, { ok: false, reason: 'There are too few comparable awards for a brief.' });
});

test('the prompt carries only this client and asks for no digits', async () => {
  let request;
  await draftBrief(facts, { llm: async (r) => { request = r; return clean; }, model: 'qwen/qwen3.7-plus' });
  assert.equal(request.model, 'qwen/qwen3.7-plus');
  assert.match(request.system, /digits/);
  assert.match(request.system, /winning price/);
  assert.ok(JSON.parse(request.user).client.name === 'Aster Events');
});

test('composeBrief writes no-bid as Do not bid', () => {
  assert.match(composeBrief({ ...clean, recommendation: 'no-bid', credentials_cited: [] }, facts), /## Recommendation\n\nDo not bid/);
});
