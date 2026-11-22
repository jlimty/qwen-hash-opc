import assert from 'node:assert/strict';
import test from 'node:test';
import { computeRiskFacts, formatSgd } from '../src/brief-risk.mjs';

const band = { low_cents: 20880000, median_cents: 45000000, high_cents: 115310900 };
const calm = { n: 57, band: { low_cents: 30000000, median_cents: 45000000, high_cents: 60000000 }, maxContractCents: 100000000,
  content: 'Bid with care.', citedCount: 1, verifiedProjectCount: 2, priorBriefCount: 1 };
const codes = (result) => result.facts.map((f) => f.code);
const message = (result, code) => result.facts.find((f) => f.code === code)?.message;

test('formatSgd shows whole dollars without decimals and cents only when present', () => {
  assert.equal(formatSgd(61200000), 'S$612,000');
  assert.equal(formatSgd(115310950), 'S$1,153,109.50');
  assert.equal(formatSgd(0), 'S$0');
});

test('a calm brief has no facts and is low risk', () => {
  assert.deepEqual(computeRiskFacts(calm), { facts: [], level: 'low' });
});

test('band figures in common formats are matched', () => {
  const result = computeRiskFacts({ ...calm, band, content: 'Band S$208,800 to S$1,153,109.00, median $450k, 57 comparables, about $1.15m top. Also 20880000 cents.' });
  assert.equal(codes(result).includes('unmatched_numbers'), false);
});

test('years and percentages are unmatched, and words after a number are not suffixes', () => {
  const result = computeRiskFacts({ ...calm, band, content: 'In 2026 more events; we expect a 40% margin.' });
  assert.equal(message(result, 'unmatched_numbers'), '2 figures in the text are not band figures: 2026, 40%.');
  assert.equal(message(computeRiskFacts({ ...calm, content: 'Team of 12.' }), 'unmatched_numbers'), '1 figure in the text is not a band figure: 12.');
});

test('each fact has its exact message', () => {
  assert.equal(message(computeRiskFacts({ ...calm, n: 9 }), 'thin_evidence'), 'Only 9 comparable contracts.');
  assert.equal(message(computeRiskFacts({ ...calm, band }), 'wide_band'), 'Band is wide: top is 5.5× the bottom.');
  assert.equal(message(computeRiskFacts({ ...calm, band: { low_cents: 0, median_cents: 1, high_cents: 2 } }), 'wide_band'), 'Band is wide: the bottom is S$0.');
  assert.equal(message(computeRiskFacts({ ...calm, band: { ...band, median_cents: 61200000 }, maxContractCents: 20000000 }), 'above_ceiling'),
    "Median S$612,000 is above the client's S$200,000 ceiling.");
  assert.equal(message(computeRiskFacts({ ...calm, citedCount: 0 }), 'no_citations'), 'No verified project cited.');
  assert.equal(message(computeRiskFacts({ ...calm, priorBriefCount: 0 }), 'thin_history'), 'First brief from this client.');
  assert.equal(message(computeRiskFacts({ ...calm, verifiedProjectCount: 1 }), 'thin_history'), 'Only 1 verified project on record.');
});

test('level follows the number of facts', () => {
  assert.equal(computeRiskFacts({ ...calm, n: 9 }).level, 'medium');
  assert.equal(computeRiskFacts({ ...calm, n: 9, citedCount: 0 }).level, 'medium');
  assert.equal(computeRiskFacts({ ...calm, n: 9, citedCount: 0, priorBriefCount: 0 }).level, 'high');
});

test('a non-round band accepts rounded dollars, raw cents and million wording, and ignores tender numbers', () => {
  const demo = { low_cents: 20880000, median_cents: 45000000, high_cents: 115310863 };
  for (const content of ['Band S$208,800 to S$1,153,109.', 'Top S$1,153,108.63, or 115310863 cents.', 'About S$1.15 million at the top.',
    'Tender DST000ETT26000005 for Brainhack.', 'Top S$1,153,108 when rounded down.']) {
    const result = computeRiskFacts({ ...calm, band: demo, content });
    assert.equal(codes(result).includes('unmatched_numbers'), false, content);
  }
  assert.equal(message(computeRiskFacts({ ...calm, band: demo, content: 'Tender DST000ETT26000005 in 2026.' }), 'unmatched_numbers'),
    '1 figure in the text is not a band figure: 2026.');
});

test('roughSpread rounds the span of awards to two significant figures, for thin evidence', async () => {
  const { roughSgd, roughSpread } = await import('../src/brief-risk.mjs');
  assert.equal(roughSgd(9568800), 'S$96k');
  assert.equal(roughSgd(28680000), 'S$290k');
  assert.equal(roughSgd(186045000), 'S$1.9M');
  assert.equal(roughSgd(84000), 'S$840');
  assert.equal(roughSpread([28680000, 9568800, 15000000]), 'from about S$96k to S$290k');
});
