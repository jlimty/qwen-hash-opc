import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTenderCsv } from '../src/tender-data.mjs';
import { fitFacts, pastedTenderNo, priceCheck, priceLimits } from '../src/price-check.mjs';

const header = 'tender_no,tender_description,agency,award_date,tender_detail_status,supplier_name,awarded_amt\n';
const dataset = parseTenderCsv(header + [
  ...[1, 2, 3].map((i) => `OLD-${i},Event management services,Agency A,1/${i}/2025,Awarded to Suppliers,Past supplier,${i * 100000}.00`),
  ...[1, 2].map((i) => `NEW-${i},Event management services,Agency B,2/${i}/2026,Awarded to Suppliers,Recent supplier,${i * 200000}.00`),
  'CLN-1,Cleaning services,Agency C,1/1/2025,Awarded to Suppliers,Cleaner,5000.00',
].join('\n'));

test('priceCheck includes held-out awards and reports the query it used', () => {
  const check = priceCheck(dataset, { terms: ['event management', 'zzz'], category: 'events-community' });
  assert.equal(check.status, 'ready');
  assert.equal(check.query_used, 'event management');
  assert.equal(check.snapshot.n, 5);
  assert.equal(check.comparables.length, 5);
  assert.equal(check.comparables[0].tender_no, 'NEW-2');
  assert.equal(check.comparables[0].awarded_cents, 40000000);
  assert.deepEqual(check.comparables[0].suppliers, ['Recent supplier']);
  assert.equal(check.limits, priceLimits);
});

test('priceCheck reports too few comparables honestly', () => {
  const check = priceCheck(dataset, { terms: ['submarine'] });
  assert.equal(check.status, 'insufficient_comparables');
  assert.equal(check.snapshot.price_band, undefined);
  assert.equal(check.limits, 'Past awards from April 2021 to March 2026. Not a quote, and not a winning price. GeBIZ publishes winning amounts only.');
});

test('priceCheck with no terms falls back to the category alone', () => {
  const check = priceCheck(dataset, { terms: [], category: 'events-community' });
  assert.equal(check.status, 'ready');
  assert.equal(check.query_used, null);
});

test('fitFacts compares capacity with the median and counts related verified projects', () => {
  const check = priceCheck(dataset, { terms: ['event management'], category: 'events-community' });
  const facts = fitFacts({ client: { categories: ['events-community'], max_contract_cents: 10000000 },
    verifiedProjects: [{ title: 'Annual event for a ministry' }, { title: 'Office cleaning' }], tender: { category: 'events-community' }, check });
  assert.deepEqual(facts, { category_match: true, within_capacity: false, related_projects: 1 });
  const none = fitFacts({ client: { categories: ['security'], max_contract_cents: 1 }, verifiedProjects: [], tender: { category: 'events-community' },
    check: priceCheck(dataset, { terms: ['submarine'] }) });
  assert.deepEqual(none, { category_match: false, within_capacity: null, related_projects: 0 });
});

test('pastedTenderNo is stable across spacing and case', () => {
  const a = pastedTenderNo({ title: 'Event  Management', agency: 'Agency A ' });
  assert.match(a, /^PASTED-[a-f0-9]{16}$/);
  assert.equal(a, pastedTenderNo({ title: 'event management', agency: 'agency a' }));
  assert.notEqual(a, pastedTenderNo({ title: 'event management', agency: 'agency b' }));
});
