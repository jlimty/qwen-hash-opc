import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { parseTenderCsv } from '../src/tender-data.mjs';
import { buildStatsSnapshot } from '../src/tender-stats.mjs';

const header = 'tender_no,tender_description,agency,award_date,tender_detail_status,supplier_name,awarded_amt\n';
const dataset = (extra = []) => parseTenderCsv(header + [
  'H1,Event management,Agency A,1/1/2025,Awarded by Items,Supplier A,40',
  'H1,Event management,Agency A,1/1/2025,Awarded by Items,Supplier A,60',
  'H2,Event management,Agency A,1/2/2025,Awarded by Items,Supplier A,100',
  'H2,Event management,Agency A,1/2/2025,Awarded by Items,Supplier B,100',
  'H3,Event management,Agency A,1/3/2025,Awarded to Suppliers,Supplier B,300',
  'H4,Event management,Agency A,1/4/2025,Awarded to Suppliers,Supplier C,400',
  'H5,Event management,Agency A,1/5/2025,Awarded to Suppliers,Supplier A,500',
  'ZERO,Event management,Agency A,1/6/2025,Awarded to Suppliers,ZeroSupplier,0',
  'NONE,Event management,Agency A,1/6/2025,Awarded to No Suppliers,na,0',
  'HELD,Event management,Agency A,1/1/2026,Awarded to Suppliers,SecretWinner,9999999',
  'OTHER,Cleaning services,Agency B,1/1/2025,Awarded to Suppliers,Cleaner,900',
  ...extra,
].join('\n'));

test('uses five distinct positive historical contracts, never source rows, for percentiles', () => {
  const result = buildStatsSnapshot(dataset(), { category: 'events-community' });
  assert.equal(result.status, 'ready');
  assert.equal(result.n, 5);
  assert.equal(result.minimum_comparables, 5);
  assert.equal(result.currency, 'SGD');
  assert.deepEqual(result.price_band, { low_cents: 20000, median_cents: 30000, high_cents: 40000 });
  assert.deepEqual(result.comparables.map((c) => c.tender_no), ['H1', 'H2', 'H3', 'H4', 'H5']);
  assert.deepEqual(result.comparables[0], { tender_no: 'H1', total_awarded_cents: 10000, source_records: [1, 2] });
  assert.doesNotMatch(JSON.stringify(result), /SecretWinner|9999999|ZeroSupplier|"HELD"|"NONE"|"ZERO"/);
});

test('counts one supplier win per contract even for repeated item awards', () => {
  const result = buildStatsSnapshot(dataset(), { query: 'event' });
  assert.deepEqual(result.top_suppliers, [
    { name: 'Supplier A', wins: 3, share: 0.6 },
    { name: 'Supplier B', wins: 2, share: 0.4 },
    { name: 'Supplier C', wins: 1, share: 0.2 },
  ]);
  assert.equal(result.supplier_share_basis, 'fraction-of-comparable-contracts');
  assert.deepEqual(result.top_agencies, [{ name: 'Agency A', contracts: 5, share: 1 }]);
  assert.equal(result.likely_incumbent, null);
  assert.deepEqual(buildStatsSnapshot(dataset(), { query: 'event', agency: 'Agency A' }).likely_incumbent,
    { name: 'Supplier A', wins: 3 });
});

test('incumbent ties resolve by latest award and then supplier name', () => {
  const text = header + [
    'A1,Event services,Agency A,1/1/2025,Awarded to Suppliers,Supplier A,100',
    'A2,Event services,Agency A,1/6/2025,Awarded to Suppliers,Supplier A,100',
    'B1,Event services,Agency A,1/2/2025,Awarded to Suppliers,Supplier B,100',
    'B2,Event services,Agency A,1/6/2025,Awarded to Suppliers,Supplier B,100',
    'C1,Event services,Agency A,1/3/2025,Awarded to Suppliers,Supplier C,100',
    'C2,Event services,Agency A,1/5/2025,Awarded to Suppliers,Supplier C,100',
  ].join('\n');
  const filters = { query: 'event', agency: 'Agency A' };
  assert.equal(buildStatsSnapshot(parseTenderCsv(text), filters).likely_incumbent.name, 'Supplier A');
  const earlierA = text.replace('A2,Event services,Agency A,1/6/2025', 'A2,Event services,Agency A,1/4/2025');
  assert.equal(buildStatsSnapshot(parseTenderCsv(earlierA), filters).likely_incumbent.name, 'Supplier B');
});

test('refuses to produce a price band from fewer than five distinct eligible contracts', () => {
  const result = buildStatsSnapshot(dataset(), { query: 'event', to: '2025-04-01' });
  assert.equal(result.status, 'insufficient_comparables');
  assert.equal(result.n, 4);
  assert.equal(Object.hasOwn(result, 'price_band'), false);
  assert.equal(Object.hasOwn(result, 'top_suppliers'), false);
  const none = buildStatsSnapshot(dataset(), { query: 'nonexistent', agency: 'Agency A' });
  assert.equal(none.n, 0);
  assert.equal(none.status, 'insufficient_comparables');
});

test('does not broaden category or agency filters to fill insufficient samples', () => {
  const result = buildStatsSnapshot(dataset(), { category: 'events-community', agency: 'Agency B' });
  assert.equal(result.n, 0);
  assert.deepEqual(result.comparables, []);
  assert.throws(() => buildStatsSnapshot(dataset(), {}));
  assert.throws(() => buildStatsSnapshot(dataset(), { query: 'event', limit: 1 }));
  assert.throws(() => buildStatsSnapshot(dataset(), { category: 'unknown' }));
});

test('interpolates quartiles and rounds half-up to cents without integer overflow', () => {
  const cents = [1, 2, 3, 4, 5, 6];
  const data = parseTenderCsv(header + cents.map((n) =>
    `P${n},Event services,Agency A,1/1/2025,Awarded to Suppliers,Supplier A,0.0${n}`).join('\n'));
  assert.deepEqual(buildStatsSnapshot(data, { query: 'event' }).price_band,
    { low_cents: 2, median_cents: 4, high_cents: 5 });
  const huge = parseTenderCsv(header + cents.map((n) =>
    `P${n},Event services,Agency A,1/1/2025,Awarded to Suppliers,Supplier A,90071992547409.9${n % 2}`).join('\n'));
  assert.deepEqual(buildStatsSnapshot(huge, { query: 'event' }).price_band,
    { low_cents: 9007199254740990, median_cents: 9007199254740991, high_cents: 9007199254740991 });
});

test('snapshots are reproducible, provenance-bound and immutable down to source records', () => {
  const data = dataset();
  const a = buildStatsSnapshot(data, { query: 'EVENT', agency: 'Agency A' });
  const b = buildStatsSnapshot(data, { agency: 'agency a', query: ' event ' });
  assert.deepEqual(a, b);
  assert.equal(a.dataset_sha256, data.dataset_sha256);
  assert.equal(a.algorithm_version, 'contract-percentiles-v1');
  assert.equal(a.taxonomy_version, 'keywords-v1');
  const { stat_id, ...payload } = a;
  assert.equal(stat_id, `stat_${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`);
  assert.notEqual(buildStatsSnapshot(data, { query: 'event' }).stat_id, a.stat_id);
  assert.notEqual(buildStatsSnapshot(dataset(['NEW,Event services,Agency A,1/7/2025,Awarded to Suppliers,Supplier A,600']),
    { query: 'event', agency: 'agency a' }).stat_id, a.stat_id);
  assert.throws(() => { a.price_band.low_cents = 1; }, TypeError);
  assert.throws(() => { a.comparables[0].source_records.push(9); }, TypeError);
  assert.throws(() => { a.filters.query = 'cleaning'; }, TypeError);
  assert.throws(() => { a.top_suppliers[0].wins = 9; }, TypeError);
});

test('never counts a zero-value supplier item as a positive-contract win', () => {
  const result = buildStatsSnapshot(dataset([
    'H1,Event management,Agency A,1/1/2025,Awarded by Items,ZeroSupplier,0',
  ]), { query: 'event' });
  assert.equal(result.top_suppliers.some((s) => s.name === 'ZeroSupplier'), false);
});

test('includeHoldout adds held-out awards under a distinct stat_id and leaves backtest snapshots unchanged', () => {
  const backtest = buildStatsSnapshot(dataset(), { category: 'events-community' });
  assert.equal(backtest.stat_id, 'stat_f0382665c4922d9da91b5cdf2eecd218131330868bd6123c8d1d82687205502c');
  const all = buildStatsSnapshot(dataset(), { category: 'events-community' }, { includeHoldout: true });
  assert.equal(all.n, 1, 'only the held-out award is at least S$1,000; the S$0.40-S$5 rows are nominal');
  assert.equal(all.scope, 'all-awards');
  assert.notEqual(all.stat_id, backtest.stat_id);
  assert.ok(all.comparables.some((c) => c.tender_no === 'HELD'));
});

test('live snapshots drop nominal awards under S$1,000 and flag a band wider than five times', () => {
  const live = buildStatsSnapshot(dataset([
    'P1,Event management,Agency A,1/7/2025,Awarded to Suppliers,Panel Co,5',
    'P2,Event management,Agency A,1/8/2025,Awarded to Suppliers,Panel Co,999.99',
  ]), { category: 'events-community' }, { includeHoldout: true });
  assert.ok(!live.comparables.some((c) => ['P1', 'P2'].includes(c.tender_no)));
  assert.equal(live.minimum_award_cents, 100000);
  assert.equal(typeof live.wide_band, 'boolean');
  const backtest = buildStatsSnapshot(dataset(), { category: 'events-community' });
  assert.equal(backtest.stat_id, 'stat_f0382665c4922d9da91b5cdf2eecd218131330868bd6123c8d1d82687205502c');
  assert.equal(backtest.minimum_award_cents, undefined);
});
