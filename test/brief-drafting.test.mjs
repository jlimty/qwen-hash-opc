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
  price_position: { band: 'lower_quartile_to_median', why: 'The scope is standard and the team is small, so there is no case for a premium.' },
  requirements: [], questions: [], risks: [], credentials_cited: [verified] };
const llmReturning = (value) => async () => value;

test('a clean draft is composed with code-written figures and passes the figure check', async () => {
  const result = await draftBrief(facts, { llm: llmReturning(clean), model: 'm' });
  assert.equal(result.ok, true);
  assert.equal(result.draft.recommendation, 'bid');
  assert.deepEqual(result.draft.credentials_cited, [verified]);
  const content = result.draft.content;
  for (const heading of ['Recommendation', 'Why', 'Suggested price range', 'Who usually wins', 'Your verified projects cited', 'Comparable awards', 'Limits']) assert.match(content, new RegExp(`## ${heading}`));
  assert.ok(content.includes(formatSgd(band.median_cents)));
  assert.ok(content.includes('Annual ministry event'));
  assert.ok(content.includes(briefLimits));
  const risk = computeRiskFacts({ n: 23, band, maxContractCents: 50000000, content: result.draft.risk_text, citedCount: 1, verifiedProjectCount: 2, priorBriefCount: 1 });
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
  const unusable = await draftBrief(facts, { llm: llmReturning({ recommendation: 'maybe' }), model: 'm' });
  assert.equal(unusable.ok, false);
  assert.match(unusable.reason, /^The model returned an unusable draft \(recommendation: .+\)\. Try Redraft\.$/);
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

test('the brief carries no agency list, so agency names with digits never trip the figure check', () => {
  const { content } = composeBrief(clean, { ...facts, snapshot: { ...facts.snapshot, top_agencies: [{ name: 'Ministry Headquarter 1', contracts: 4 }] } });
  assert.doesNotMatch(content, /Headquarter 1/);
});

test('composeBrief writes no-bid as Do not bid', () => {
  assert.match(composeBrief({ ...clean, recommendation: 'no-bid', credentials_cited: [] }, facts).content, /## Recommendation\n\nDo not bid/);
});

test('a model failure keeps its reason for the admin', async () => {
  const result = await draftBrief(facts, { llm: async () => { throw new Error('model unavailable: HTTP 400: bad schema'); }, model: 'm' });
  assert.deepEqual(result, { ok: false, reason: 'The model was unavailable (HTTP 400: bad schema). Try Redraft.' });
});

test('drafting allows the model 90 seconds and asks for low reasoning effort, so the console request finishes', async () => {
  let request;
  await draftBrief(facts, { llm: async (r) => { request = r; return clean; }, model: 'm' });
  assert.equal(request.timeoutMs, 90000);
  assert.deepEqual(request.reasoning, { effort: 'low' });
});

test('the instructions keep price out of the reasons, ask for the reason behind the price position, and ban internal labels', async () => {
  let request;
  await draftBrief(facts, { llm: async (r) => { request = r; return clean; }, model: 'm' });
  assert.match(request.system, /Keep price out of the reasons/);
  assert.match(request.system, /say why/i);
  assert.match(request.system, /Judge each verified project by its title and agency/);
  assert.match(request.system, /never use internal labels/i);
  const sent = JSON.parse(request.user);
  assert.equal(sent.fit.related_projects, undefined, 'the narrow keyword count no longer steers citations');
  assert.deepEqual(sent.fit, { in_your_categories: true, median_compared_with_your_largest_contract: 'within' });
  assert.match(request.jsonSchema.properties.price_position.properties.why.description, /why/i);
});

test('a bare price position with no reason is refused as unusable', async () => {
  const result = await draftBrief(facts, { llm: async () => ({ ...clean, price_position: { band: 'lower_quartile_to_median', why: 'Standard.' } }), model: 'm' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /unusable draft \(price_position\.why: .*too short/i);
});

test('a reason that talks about price is refused, so price lives in one place', async () => {
  const result = await draftBrief(facts, { llm: async () => ({ ...clean, reasons: ['Price position: between the lower quartile and the median.'] }), model: 'm' });
  assert.deepEqual(result, { ok: false, reason: 'Draft repeated the price position in its reasons. Try Redraft.' });
});

test('quantities written in words are refused like any other figure the code did not compute', async () => {
  for (const reason of ['The ministry accounts for roughly a third of comparable awards.', 'About half of past winners were small firms.',
    'This buyer issued twice as many tenders as others.', 'Winners were paid ten percent more in recent years.', 'The scope covers four buildings.']) {
    const result = await draftBrief(facts, { llm: async () => ({ ...clean, reasons: [reason] }), model: 'm' });
    assert.equal(result.ok, false, reason);
    assert.match(result.reason, /^Draft stated quantities in words: .+\. Try Redraft\.$/, reason);
  }
  const fine = await draftBrief(facts, { llm: async () => ({ ...clean, reasons: ['One of the most active buyers of this work, and acting on behalf of a ministry.'] }), model: 'm' });
  assert.equal(fine.ok, true, fine.reason);
});

test('a refused draft is retried with the refusal fed back to the model', async () => {
  const requests = [];
  const llm = async (request) => { requests.push(request); return requests.length === 1
    ? { ...clean, reasons: ['About half of past winners were small firms.'] } : clean; };
  const result = await draftBrief(facts, { llm, model: 'm' });
  assert.equal(result.ok, true, result.reason);
  assert.equal(requests.length, 2);
  const sent = JSON.parse(requests[1].user);
  assert.match(sent.previous_refusal, /quantities in words: half/);
});

test('after three refused attempts the draft stays refused for the admin', async () => {
  let calls = 0;
  const llm = async () => { calls++; return { ...clean, reasons: ['About half of past winners were small firms.'] }; };
  const result = await draftBrief(facts, { llm, model: 'm' });
  assert.equal(calls, 3);
  assert.deepEqual(result, { ok: false, reason: 'Draft stated quantities in words: half. Try Redraft.' });
});

test('an unavailable model is not retried', async () => {
  let calls = 0;
  const llm = async () => { calls++; throw new Error('model unavailable'); };
  const result = await draftBrief(facts, { llm, model: 'm' });
  assert.equal(calls, 1);
  assert.deepEqual(result, { ok: false, reason: 'The model was unavailable. Try Redraft.' });
});

test('the instructions say quantities in words count as figures', async () => {
  let request;
  await draftBrief(facts, { llm: async (r) => { request = r; return clean; }, model: 'm' });
  assert.match(request.system, /quantities in words/);
});

test('a two-sentence reason of around 400 characters is fine; a rambling one over 600 is not', async () => {
  const reason = 'You hold a checked project in this exact role for the same agency, which is the clearest evidence a buyer can ask for. '
    + 'The work is specialist and registration-gated, so a small team is not a disadvantage here, and the buyer issues this kind of work regularly enough that a good result now builds a record for later tenders.';
  assert.ok(reason.length > 300 && reason.length < 600, `${reason.length}`);
  assert.equal((await draftBrief(facts, { llm: async () => ({ ...clean, reasons: [reason] }), model: 'm' })).ok, true);
  const rambling = await draftBrief(facts, { llm: async () => ({ ...clean, reasons: ['word '.repeat(130)] }), model: 'm' });
  assert.match(rambling.reason, /reasons\.0: too long \(\d+ characters, allows at most 600\)/);
});

test('the instructions ask for one or two sentences per reason', async () => {
  let request;
  await draftBrief(facts, { llm: async (r) => { request = r; return clean; }, model: 'm' });
  assert.match(request.system, /one or two sentences each/);
});

test('a draft that writes an internal ID is refused, and the prompt says to name projects by title', async () => {
  for (const reason of [`Your verified project (id: ${verified}) is relevant.`, 'Project PRJ00004 fits well.']) {
    const result = await draftBrief(facts, { llm: async () => ({ ...clean, reasons: [reason] }), model: 'm' });
    assert.equal(result.ok, false, reason);
    assert.match(result.reason, /internal ID/);
  }
  let request;
  await draftBrief(facts, { llm: async (r) => { request = r; return clean; }, model: 'm' });
  assert.match(request.system, /by its title, never by an ID/);
});

test('code turns the chosen band position into a suggested range in dollars', async () => {
  const { suggestedRange } = await import('../src/brief-drafting.mjs');
  assert.deepEqual(suggestedRange(band, 'lower_quartile_to_median'), { from_cents: 20000000, to_cents: 30000000, text: 'S$200,000 to S$300,000' });
  assert.deepEqual(suggestedRange(band, 'below_lower_quartile'), { to_cents: 20000000, text: 'Below S$200,000' });
  assert.deepEqual(suggestedRange(band, 'above_upper_quartile'), { from_cents: 50000000, text: 'Above S$500,000' });
  const result = await draftBrief(facts, { llm: llmReturning(clean), model: 'm' });
  assert.match(result.draft.content, /## Suggested price range\n\nS\$200,000 to S\$300,000\n\nThe scope is standard/);
  assert.deepEqual(result.draft.parts.suggested_range, { from_cents: 20000000, to_cents: 30000000, text: 'S$200,000 to S$300,000' });
});

test('the brief lists who usually wins, from the comparables, and carries structured parts', async () => {
  const result = await draftBrief({ ...facts, snapshot: { ...facts.snapshot, top_suppliers: [{ name: 'Supplier X', wins: 3 }, { name: 'Supplier Y', wins: 2 }] } },
    { llm: llmReturning(clean), model: 'm' });
  assert.match(result.draft.content, /## Who usually wins\n\n- Supplier X\n- Supplier Y/);
  assert.deepEqual(result.draft.parts.winners, [{ name: 'Supplier X', wins: 3 }, { name: 'Supplier Y', wins: 2 }]);
  assert.equal(result.draft.parts.n, 23);
  assert.equal(result.draft.parts.recommendation, 'bid');
  assert.deepEqual(result.draft.parts.cited, [{ title: 'Annual ministry event', agency: 'Agency A' }]);
});

test('a requirements check, questions and risks come through when the customer pasted requirements', async () => {
  const withReq = { ...facts, requirements_text: 'Bidder must have run an event for a ministry. Must hold public liability insurance.' };
  let request;
  const draft = { ...clean, requirements: [{ requirement: 'Ran an event for a ministry', status: 'met', evidence: 'Annual ministry event' },
    { requirement: 'Public liability insurance', status: 'gap', evidence: 'No policy on record' }],
  questions: ['Can the event date move if there is bad weather?'], risks: ['The agency may expect an in-house safety officer.'] };
  const result = await draftBrief(withReq, { llm: async (r) => { request = r; return draft; }, model: 'm' });
  assert.equal(result.ok, true, result.reason);
  assert.match(JSON.parse(request.user).requirements_text, /public liability/);
  assert.match(result.draft.content, /## Requirements check\n\n- Met: Ran an event for a ministry \(Annual ministry event\)\n- Gap: Public liability insurance \(No policy on record\)/);
  assert.match(result.draft.content, /## Questions to ask the agency\n\n- Can the event date move/);
  assert.match(result.draft.content, /## Risks\n\n- The agency may expect/);
  assert.equal(result.draft.parts.requirements.length, 2);
});

test('without pasted requirements, a requirements list from the model is dropped', async () => {
  const result = await draftBrief(facts, { llm: llmReturning({ ...clean, requirements: [{ requirement: 'Invented', status: 'met', evidence: 'x' }] }), model: 'm' });
  assert.equal(result.ok, true);
  assert.doesNotMatch(result.draft.content, /Requirements check/);
  assert.deepEqual(result.draft.parts.requirements, []);
});

test('a question that invents a price is refused', async () => {
  const result = await draftBrief(facts, { llm: llmReturning({ ...clean, questions: ['Would the agency accept S$123,456?'] }), model: 'm' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /figures not in the comparables/);
});

test("an admin's redraft note reaches the model", async () => {
  let request;
  await draftBrief(facts, { llm: async (r) => { request = r; return clean; }, model: 'm', note: 'Mention their school programmes.' });
  assert.equal(JSON.parse(request.user).admin_note, 'Mention their school programmes.');
});

test('questions and risks may quote tender facts like durations; only invented money figures are refused there', async () => {
  const ok = await draftBrief({ ...facts, requirements_text: 'A 6-month delivery period within a 2-year term.' },
    { llm: llmReturning({ ...clean, questions: ['Can the 6-month delivery period start in March?'], risks: ['The 2-year term ties up the team.'] }), model: 'm' });
  assert.equal(ok.ok, true, ok.reason);
  const bad = await draftBrief(facts, { llm: llmReturning({ ...clean, risks: ['Rivals may bid near $250k.'] }), model: 'm' });
  assert.equal(bad.ok, false);
});

test('digits inside known names (an agency like "Ministry of Defence 6") are not figures', async () => {
  const named = { ...facts, tender: { ...facts.tender, agency: 'Ministry of Defence 6' } };
  const ok = await draftBrief(named, { llm: llmReturning({ ...clean, reasons: ['Ministry of Defence 6 buys this kind of work and your ministry event fits it.'] }), model: 'm' });
  assert.equal(ok.ok, true, ok.reason);
  const stillCaught = await draftBrief(named, { llm: llmReturning({ ...clean, reasons: ['Ministry of Defence 6 usually pays 7 suppliers.'] }), model: 'm' });
  assert.equal(stillCaught.ok, false);
});

test('numbers in requirements, questions and risks must come from the tender or pasted requirements', async () => {
  const withReq = { ...facts, requirements_text: 'Bidder must have 5 years of experience. Delivery within 6 months.' };
  const fromTender = await draftBrief(withReq, { llm: llmReturning({ ...clean, questions: ['Can the 6 months start later?'],
    requirements: [{ requirement: 'At least 5 years of experience', status: 'met', evidence: 'Annual ministry event' }] }), model: 'm' });
  assert.equal(fromTender.ok, true, fromTender.reason);
  const invented = await draftBrief(withReq, { llm: llmReturning({ ...clean, risks: ['Only 3 of the last 12 awards went to small firms.'] }), model: 'm' });
  assert.equal(invented.ok, false);
  assert.match(invented.reason, /not in the tender/);
  const money = await draftBrief(withReq, { llm: llmReturning({ ...clean, requirements: [{ requirement: 'Capacity', status: 'gap', evidence: 'Your largest contract, S$2.4M, falls short' }] }), model: 'm' });
  assert.equal(money.ok, false);
});

test('a no-bid brief carries no price advice: no suggested range and no price reasoning', async () => {
  const result = await draftBrief(facts, { llm: llmReturning({ ...clean, recommendation: 'no-bid' }), model: 'm' });
  assert.equal(result.ok, true);
  assert.equal(result.draft.parts.suggested_range, null);
  assert.equal(result.draft.parts.price_position, null);
  assert.doesNotMatch(result.draft.content, /Suggested price range/);
  assert.doesNotMatch(result.draft.content, /no case for a premium/);
});

test('thin evidence means no dollar range: the brief says why and keeps only a rough position', async () => {
  const thin = { ...facts, snapshot: { ...facts.snapshot, n: 7, thin: true, excluded_panels: 2, excluded_trips: 4 } };
  const result = await draftBrief(thin, { llm: llmReturning(clean), model: 'm' });
  assert.equal(result.ok, true);
  const { parts, content } = result.draft;
  assert.equal(parts.suggested_range, null);
  assert.equal(parts.thin, true);
  assert.equal(parts.excluded_panels, 2);
  assert.equal(parts.excluded_trips, 4);
  assert.equal(parts.position_text, 'Between the lower quartile and the median');
  assert.match(content, /## Where to price/);
  assert.match(content, /No dollar range: too few comparable awards, or awards too varied/);
  assert.doesNotMatch(content, /## Suggested price range/);
  assert.doesNotMatch(content, /lower quartile S\$|upper quartile S\$/, 'thin evidence lists no quartiles');
  assert.match(content, /7 comparable past awards for "event management": too few or too varied for quartiles/);
});

test('ranges and quartiles in the brief are whole dollars', () => {
  const odd = { ...facts, snapshot: { ...facts.snapshot, price_band: { low_cents: 1234567, median_cents: 2345678, high_cents: 3456789 } } };
  const { content, parts } = composeBrief(clean, odd);
  assert.equal(parts.suggested_range.text, 'S$12,346 to S$23,457');
  assert.match(content, /lower quartile S\$12,346, median S\$23,457, upper quartile S\$34,568/);
});

test('a verified project named in the text is cited by code, so the brief never contradicts itself', async () => {
  const draft = { ...clean, reasons: ['Your Annual ministry event shows you can run this kind of work.', 'The agency buys this often.'], credentials_cited: [] };
  const result = await draftBrief(facts, { llm: llmReturning(draft), model: 'm' });
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(result.draft.credentials_cited, [verified]);
  assert.deepEqual(result.draft.parts.cited.map((p) => p.title), ['Annual ministry event']);
});
