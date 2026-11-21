import assert from 'node:assert/strict';
import test from 'node:test';
import { crossCheckProject, normaliseCompany } from '../src/gebiz-check.mjs';
import { parseTenderCsv } from '../src/tender-data.mjs';

const dataset = parseTenderCsv('tender_no,tender_description,agency,award_date,tender_detail_status,supplier_name,awarded_amt\n' + [
  'OLD-9,Night market management,Agency A,3/6/2024,Awarded to Suppliers,CEDAR MARKETS PTE. LTD.,90000',
  'OLD-9,Night market management,Agency A,3/6/2024,Awarded to Suppliers,OTHER CO,10000',
  'NEW-9,Festival management,Agency B,1/2/2026,Awarded to Suppliers,CEDAR MARKETS PTE. LTD.,50000',
].join('\n'));

test('normaliseCompany ignores case, punctuation and the company-form suffix', () => {
  assert.equal(normaliseCompany('Cedar Markets Pte. Ltd.'), normaliseCompany('CEDAR MARKETS'));
  assert.equal(normaliseCompany('cedar  markets private limited'), 'CEDAR MARKETS');
  assert.notEqual(normaliseCompany('Cedar Market'), normaliseCompany('Cedar Markets'));
});

test('multi-supplier tender matches on any row and shows that supplier amount', () => {
  const check = crossCheckProject(dataset, { gebiz_tender_no: 'OLD-9', agency: 'Agency A', value_cents: 9000000 }, 'Cedar Markets', new Set());
  assert.equal(check.result, 'match');
  assert.deepEqual(check.lines, [
    'Tender OLD-9 exists · awarded 2024-06-03 · Agency A',
    'Agency claimed: Agency A',
    'Supplier on record: CEDAR MARKETS PTE. LTD. / OTHER CO — matches "Cedar Markets"',
    'Claimed S$90,000 · awarded S$90,000',
  ]);
});

test('a different supplier is no match, and the total award is shown', () => {
  const check = crossCheckProject(dataset, { gebiz_tender_no: 'OLD-9' }, 'Birch Events', new Set());
  assert.equal(check.result, 'no_match');
  assert.match(check.lines[2], /does not match "Birch Events"$/);
  assert.equal(check.lines[1], 'Agency claimed: not given');
  assert.equal(check.lines[3], 'Claimed no value · awarded S$100,000');
});

test('no number, an unknown number, and an unrevealed hold-out tender', () => {
  assert.deepEqual(crossCheckProject(dataset, {}, 'Cedar Markets', new Set()), { result: 'no_match', lines: ['No GeBIZ tender number given.'] });
  assert.deepEqual(crossCheckProject(dataset, { gebiz_tender_no: 'NOPE-1' }, 'Cedar Markets', new Set()),
    { result: 'no_match', lines: ['Not found in GeBIZ awards 2021-04 to 2026-03.'] });
  assert.deepEqual(crossCheckProject(dataset, { gebiz_tender_no: 'NEW-9' }, 'Cedar Markets', new Set()),
    { result: 'not_checked', lines: ['In the backtest hold-out; not checked until revealed.'] });
  assert.equal(crossCheckProject(dataset, { gebiz_tender_no: 'NEW-9' }, 'Cedar Markets', new Set(['NEW-9'])).result, 'match');
});
