import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseTenderCsv } from '../src/tender-data.mjs';

const columns = ['tender_no', 'tender_description', 'agency', 'award_date', 'tender_detail_status', 'supplier_name', 'awarded_amt'];
const row = (overrides = {}) => ({
  tender_no: 'EVENT-1', tender_description: 'Event management services', agency: 'Agency A',
  award_date: '31/12/2025', tender_detail_status: 'Awarded to Suppliers', supplier_name: 'Supplier A', awarded_amt: '100.10',
  ...overrides,
});
const csv = (rows) => `${columns.join(',')}\r\n${rows.map((r) => columns.map((k) => `"${r[k].replaceAll('"', '""')}"`).join(',')).join('\r\n')}\r\n`;

test('parses quoted multiline CSV and retains source provenance without rounding money', () => {
  const text = `\uFEFF${csv([row({ tender_description: 'Events, "Arts"\nFestival' })])}`;
  const data = parseTenderCsv(text);
  assert.equal(data.dataset_id, 'd_acde1106003906a75c3fa052592f2fcb');
  assert.equal(data.dataset_sha256, createHash('sha256').update(text).digest('hex'));
  assert.equal(data.taxonomy_version, 'keywords-v1');
  assert.equal(data.holdout_from, '2026-01-01');
  assert.deepEqual(data.rows[0], {
    source_record: 1, tender_no: 'EVENT-1', description: 'Events, "Arts"\nFestival', agency: 'Agency A',
    award_date: '2025-12-31', status: 'Awarded to Suppliers', supplier_name: 'Supplier A',
    awarded_cents: 10010, fiscal_year: 2025, category: 'events-community', is_holdout: false,
  });
});

test('aggregates item awards by contract and keeps repeated source items', () => {
  const data = parseTenderCsv(csv([
    row({ tender_detail_status: 'Awarded by Items', awarded_amt: '0.10' }),
    row({ tender_detail_status: 'Awarded by Items', awarded_amt: '0.20' }),
    row({ tender_detail_status: 'Awarded by Items', awarded_amt: '0.20' }),
    row({ tender_detail_status: 'Awarded by Items', supplier_name: 'Supplier B', awarded_amt: '1.00' }),
  ]));
  assert.equal(data.rows.length, 4);
  assert.equal(data.contracts.length, 1);
  assert.deepEqual(data.contracts[0], {
    tender_no: 'EVENT-1', description: 'Event management services', agency: 'Agency A', category: 'events-community',
    first_award_date: '2025-12-31', last_award_date: '2025-12-31', statuses: ['Awarded by Items'],
    total_awarded_cents: 150, suppliers: [
      { name: 'Supplier A', awarded_cents: 50 }, { name: 'Supplier B', awarded_cents: 100 },
    ], source_records: [1, 2, 3, 4], is_holdout: false,
  });
});

test('quarantines an entire tender if even one item crosses the hold-out cutoff', () => {
  const data = parseTenderCsv(csv([
    row(), row({ award_date: '1/1/2026', supplier_name: 'Holdout winner' }),
    row({ tender_no: 'EVENT-2', award_date: '31/3/2026' }),
    row({ tender_no: 'EVENT-3', award_date: '1/4/2026' }),
  ]));
  assert.equal(data.rows.length, 4);
  assert.equal(data.contracts.length, 3);
  assert.ok(data.rows.every((r) => r.is_holdout));
  assert.ok(data.contracts.every((c) => c.is_holdout));
});

test('parses real calendar dates and Singapore fiscal years', () => {
  const data = parseTenderCsv(csv([
    row({ tender_no: 'FEB', award_date: '29/2/2024' }),
    row({ tender_no: 'MAR', award_date: '31/3/2025' }),
    row({ tender_no: 'APR', award_date: '1/4/2025' }),
  ]));
  assert.deepEqual(data.rows.map((r) => r.fiscal_year), [2023, 2024, 2025]);
  for (const award_date of ['29/2/2025', '31/4/2025', '0/1/2025', '1/13/2025', '2025-01-01', '1/1/0000', '']) {
    assert.throws(() => parseTenderCsv(csv([row({ award_date })])), /record 1.*award_date/i);
  }
});

test('fails closed on malformed schemas, CSV, empty data, and unsupported statuses', () => {
  for (const text of ['', columns.join(','), csv([row()]).replace('supplier_name', 'supplier'),
    csv([row()]).replace('supplier_name', 'agency'), `${columns.join(',')}\n"unterminated`]) {
    assert.throws(() => parseTenderCsv(text));
  }
  assert.throws(() => parseTenderCsv(csv([row({ tender_detail_status: 'Pending' })])), /record 1.*status/i);
  for (const key of ['tender_no', 'tender_description', 'agency']) {
    assert.throws(() => parseTenderCsv(csv([row({ [key]: '  ' })])), new RegExp(`record 1.*${key}`, 'i'));
  }
  assert.throws(() => parseTenderCsv(csv([row({ supplier_name: '' })])), /record 1.*supplier_name/i);
});

test('rejects invalid money and values outside exact integer-cent arithmetic', () => {
  for (const awarded_amt of ['-1', '1.001', '1e3', 'NaN', 'Infinity', '1,000', '', '90071992547409.92']) {
    assert.throws(() => parseTenderCsv(csv([row({ awarded_amt })])), /record 1.*awarded_amt/i);
  }
  const data = parseTenderCsv(csv([row({ awarded_amt: '90071992547409.91' })]));
  assert.equal(data.rows[0].awarded_cents, Number.MAX_SAFE_INTEGER);
  assert.throws(() => parseTenderCsv(csv([
    row({ awarded_amt: '90071992547409.91' }), row({ awarded_amt: '0.01' }),
  ])), /contract.*amount.*safe/i);
});

test('retains unsuccessful tenders but never treats their supplier label as a winner', () => {
  const data = parseTenderCsv(csv([row({ tender_detail_status: 'Awarded to No Suppliers', supplier_name: 'na', awarded_amt: '0' })]));
  assert.equal(data.contracts[0].total_awarded_cents, 0);
  assert.deepEqual(data.contracts[0].suppliers, []);
  assert.equal(data.rows[0].supplier_name, 'na');
  assert.throws(() => parseTenderCsv(csv([row({ tender_detail_status: 'Awarded to No Suppliers' })])), /record 1.*no suppliers/i);
});

test('rejects conflicting agency or description within one tender rather than choosing a row', () => {
  for (const overrides of [{ agency: 'Agency B' }, { tender_description: 'Different description' }]) {
    assert.throws(() => parseTenderCsv(csv([row(), row(overrides)])), /conflicting.*EVENT-1/i);
  }
});

test('assigns deterministic categories with word boundaries and a fallback', () => {
  const cases = [
    ['Cleaning and housekeeping for office buildings', 'cleaning-facilities'],
    ['Security guard services', 'security'],
    ['Cybersecurity software for event systems', 'ict-services'],
    ['Renovation of a community centre', 'construction-renovation'],
    ['Annual events and festivals', 'events-community'],
    ['Staff training and consultancy', 'training-consultancy'],
    ['Catering and packed meals', 'catering'],
    ['Purchase of preventative equipment', 'other'],
  ];
  const data = parseTenderCsv(csv(cases.map(([tender_description], i) => row({ tender_no: `CAT-${i}`, tender_description }))));
  assert.deepEqual(data.rows.map((r) => r.category), cases.map(([, category]) => category));
});

test('freezes normalized rows, contracts and nested provenance', () => {
  const data = parseTenderCsv(csv([row()]));
  assert.throws(() => { data.rows[0].is_holdout = true; }, TypeError);
  assert.throws(() => { data.contracts[0].suppliers[0].awarded_cents = 0; }, TypeError);
  assert.throws(() => { data.contracts[0].source_records.push(2); }, TypeError);
  assert.throws(() => { data.contracts.push({}); }, TypeError);
});

test('imports all downloaded source rows without changing the dataset', () => {
  const text = readFileSync(new URL('../data/GovernmentProcurementviaGeBIZ.csv', import.meta.url), 'utf8');
  const data = parseTenderCsv(text);
  assert.equal(data.rows.length, 18464);
  assert.equal(data.contracts.length, 12052);
  assert.equal(data.contracts.filter((c) => c.is_holdout).length, 536);
  assert.equal(data.rows.filter((r) => r.is_holdout).length, 806);
  assert.equal(data.contracts.filter((c) => !c.is_holdout).length, 11516);
  assert.equal(readFileSync(new URL('../data/GovernmentProcurementviaGeBIZ.csv', import.meta.url), 'utf8'), text);
});

test('consultancy alone is not training: an architectural consultancy is other', async () => {
  const { categorize } = await import('../src/tender-data.mjs');
  assert.equal(categorize('Provision of registered inspector (architectural) consultancy services'), 'other');
  assert.equal(categorize('Leadership training and consultancy workshop'), 'training-consultancy');
  assert.equal(categorize('Coaching for school leaders'), 'training-consultancy');
});
