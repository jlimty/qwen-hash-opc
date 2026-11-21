import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseTenderCsv } from '../src/tender-data.mjs';
import { searchHistoricalTenders, getIncomingTenders, selectHistoricalContracts } from '../src/tender-catalog.mjs';

const header = 'tender_no,tender_description,agency,award_date,tender_detail_status,supplier_name,awarded_amt\n';
const dataset = () => parseTenderCsv(header + [
  'OLD-A,Event management services,Agency A,1/6/2025,Awarded by Items,Supplier A,100',
  'OLD-A,Event management services,Agency A,1/6/2025,Awarded by Items,Supplier B,200',
  'OLD-B,Events at parks,Agency B,30/5/2025,Awarded to Suppliers,Supplier B,500',
  'OLD-C,Cleaning services,Agency A,31/12/2025,Awarded to Suppliers,Supplier C,1000',
  'NONE,Event management services,Agency A,2/6/2025,Awarded to No Suppliers,na,0',
  'MIXED,Secret festival,Agency A,31/12/2025,Awarded by Items,MixedWinner,12345',
  'MIXED,Secret festival,Agency A,1/1/2026,Awarded by Items,MixedWinner,98765',
  'NEW-A,Event management services,Agency A,31/3/2026,Awarded to Suppliers,HoldoutWinner,999999.99',
].join('\n'));

test('searches whole historical contracts using all case-insensitive query token prefixes', () => {
  const found = searchHistoricalTenders(dataset(), { query: 'eVeNt MANAGE' });
  assert.equal(found.total, 2);
  assert.deepEqual(found.items.map((r) => r.tender_no), ['NONE', 'OLD-A']);
  const awarded = found.items[1];
  assert.equal(awarded.awarded_cents, 30000);
  assert.equal(awarded.currency, 'SGD');
  assert.deepEqual(awarded.suppliers, ['Supplier A', 'Supplier B']);
  assert.equal(awarded.award_date, '2025-06-01');
  assert.equal(searchHistoricalTenders(dataset(), { query: 'event cleaning' }).total, 0);
  assert.equal(searchHistoricalTenders(dataset(), { query: "' OR 1=1 --" }).total, 0);
});

test('applies inclusive amount/date/category/agency filters at contract level', () => {
  const found = searchHistoricalTenders(dataset(), {
    query: 'event', category: 'events-community', agency: 'agency a', min_amt: 300, max_amt: 300,
    from: '2025-06-01', to: '2025-06-01',
  });
  assert.equal(found.total, 1);
  assert.equal(found.items[0].tender_no, 'OLD-A');
  assert.equal(searchHistoricalTenders(dataset(), { min_amt: 1000 }).items[0].tender_no, 'OLD-C');
  assert.equal(searchHistoricalTenders(dataset(), { to: '2025-05-30' }).items[0].tender_no, 'OLD-B');
});

test('paginates deterministically and counts matching contracts before pagination', () => {
  const first = searchHistoricalTenders(dataset(), { limit: 2 });
  const second = searchHistoricalTenders(dataset(), { limit: 2, offset: 2 });
  assert.equal(first.total, 4);
  assert.equal(second.total, 4);
  assert.deepEqual(first.items.map((r) => r.tender_no), ['OLD-C', 'NONE']);
  assert.deepEqual(second.items.map((r) => r.tender_no), ['OLD-A', 'OLD-B']);
  assert.deepEqual(searchHistoricalTenders(dataset(), { offset: 100 }).items, []);
});

test('never returns hold-out contracts through historical filters or internal comparable selection', () => {
  const data = dataset();
  for (const options of [{}, { query: 'secret' }, { from: '2026-01-01' }, { min_amt: 12345 }]) {
    const result = searchHistoricalTenders(data, options);
    assert.equal(result.items.some((r) => ['NEW-A', 'MIXED'].includes(r.tender_no)), false);
    assert.doesNotMatch(JSON.stringify(result), /HoldoutWinner|MixedWinner|999999|98765/);
  }
  assert.equal(selectHistoricalContracts(data, {}).length, 4);
  assert.equal(selectHistoricalContracts(data, {}).some((c) => c.is_holdout), false);
});

test('incoming results contain only allowlisted backtest metadata, without outcome/date/status leakage', () => {
  const found = getIncomingTenders(dataset(), { category: 'events-community', limit: 1 });
  assert.equal(found.total, 2);
  assert.deepEqual(found.items, [{
    tender_no: 'MIXED', description: 'Secret festival', agency: 'Agency A', category: 'events-community',
    data_kind: 'historical-backtest',
  }]);
  assert.equal(getIncomingTenders(dataset(), { offset: 1 }).items[0].tender_no, 'NEW-A');
  const serialized = JSON.stringify(getIncomingTenders(dataset()));
  assert.doesNotMatch(serialized, /supplier|amount|awarded|award_date|status|2026|999999|98765|source_record/i);
});

test('rejects invalid filters rather than silently widening a query', () => {
  for (const options of [
    { category: 'unknown' }, { query: '  ' }, { query: '%' }, { query: 'x'.repeat(251) },
    { agency: '' }, { limit: 0 }, { limit: 101 }, { offset: -1 }, { offset: 0.5 },
    { min_amt: -1 }, { min_amt: Infinity }, { max_amt: 0.001 }, { min_amt: 5, max_amt: 4 },
    { from: '2025-02-29' }, { from: '2025-02-01', to: '2025-01-01' },
    { is_holdout: true }, { supplier_name: 'HoldoutWinner' },
  ]) assert.throws(() => searchHistoricalTenders(dataset(), options));
  for (const options of [{ min_amt: 1 }, { query: 'HoldoutWinner' }, { limit: -1 }, { category: 'unknown' }]) {
    assert.throws(() => getIncomingTenders(dataset(), options));
  }
});

test('accepts two-decimal filters without floating-point multiplication errors', () => {
  const data = parseTenderCsv(header + 'CENTS,Event services,Agency A,1/1/2025,Awarded to Suppliers,Supplier A,0.29');
  assert.equal(searchHistoricalTenders(data, { min_amt: 0.29, max_amt: 0.29 }).total, 1);
});

test('large accepted decimal bounds retain their exact cents', () => {
  const data = parseTenderCsv(header + 'BIG,Event services,Agency A,1/1/2025,Awarded to Suppliers,Supplier A,45000000000000.02');
  const options = { min_amt: 45000000000000.02, max_amt: 45000000000000.02 };
  assert.equal(searchHistoricalTenders(data, options).total, 1);
  assert.equal(selectHistoricalContracts(data, options).length, 1);
});

test('catalog output preserves distinct cents at the supported amount limit', () => {
  const data = parseTenderCsv(header + [
    'BIG-A,Event services,Agency A,1/1/2025,Awarded to Suppliers,Supplier A,90071992547409.90',
    'BIG-B,Event services,Agency A,1/1/2025,Awarded to Suppliers,Supplier A,90071992547409.91',
  ].join('\n'));
  const items = searchHistoricalTenders(data).items;
  assert.deepEqual(items.map((item) => item.awarded_cents), [9007199254740990, 9007199254740991]);
  assert.ok(items.every((item) => item.currency === 'SGD'));
  assert.ok(items.every((item) => !Object.hasOwn(item, 'awarded_amt')));
});

test('historical date filters use the last item award date of a contract', () => {
  const data = parseTenderCsv(header + [
    'MULTI,Event services,Agency A,1/1/2025,Awarded by Items,Supplier A,100',
    'MULTI,Event services,Agency A,1/2/2025,Awarded by Items,Supplier B,200',
  ].join('\n'));
  assert.equal(searchHistoricalTenders(data, { to: '2025-01-31' }).total, 0);
  const result = searchHistoricalTenders(data, { from: '2025-02-01', to: '2025-02-01' });
  assert.equal(result.total, 1);
  assert.equal(result.items[0].award_date, '2025-02-01');
});

test('all real hold-out tenders are metadata-only and disjoint from the historical catalog', () => {
  const data = parseTenderCsv(readFileSync(new URL('../data/GovernmentProcurementviaGeBIZ.csv', import.meta.url), 'utf8'));
  const historical = new Set(selectHistoricalContracts(data).map((c) => c.tender_no));
  let count = 0;
  for (let offset = 0; offset < 536; offset += 100) {
    const page = getIncomingTenders(data, { limit: 100, offset });
    assert.equal(page.total, 536);
    for (const item of page.items) {
      assert.deepEqual(Object.keys(item).sort(), ['agency', 'category', 'data_kind', 'description', 'tender_no']);
      assert.equal(historical.has(item.tender_no), false);
      count++;
    }
  }
  assert.equal(count, 536);
  assert.equal(historical.size, 11516);
});
