import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('../scripts/tender-report.mjs', import.meta.url));
const run = (args = []) => spawnSync(process.execPath, [script, ...args], { cwd: tmpdir(), encoding: 'utf8', timeout: 10000 });

test('local report runs outside the project directory and summarizes the actual CSV', () => {
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.dataset.source_rows, 18464);
  assert.equal(report.dataset.contracts, 12052);
  assert.equal(report.dataset.historical_contracts, 11516);
  assert.equal(report.dataset.holdout_contracts, 536);
  assert.equal(report.dataset.first_award_date, '2021-04-01');
  assert.equal(report.dataset.last_award_date, '2026-03-31');
  assert.equal(report.statistics_summary.status, 'ready');
  assert.ok(report.statistics_summary.n >= 5);
  assert.ok(report.statistics_summary.stat_id.startsWith('stat_'));
  assert.equal(report.categories.reduce((sum, category) => sum + category.historical_contracts, 0), 11516);
  assert.equal(report.categories.reduce((sum, category) => sum + category.incoming_tenders, 0), 536);
  assert.equal(report.incoming_sample.items.length, 3);
  for (const item of report.incoming_sample.items) {
    assert.deepEqual(Object.keys(item).sort(), ['agency', 'category', 'data_kind', 'description', 'tender_no']);
  }
  assert.equal(report.historical_search.items.length, 5);
  assert.ok(result.stdout.length < 20000);
});

test('explicit category queries do not accidentally retain the default events query', () => {
  const result = run(['--category', 'cleaning-facilities']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.statistics_summary.filters, { category: 'cleaning-facilities' });
  assert.ok(report.historical_search.items.length > 0);
  assert.ok(report.historical_search.items.every((item) => item.category === 'cleaning-facilities'));
});

test('a query with no comparables remains an honest insufficient result', () => {
  const result = run(['--query', 'thistermcannotmatch12345']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.statistics_summary.n, 0);
  assert.equal(report.statistics_summary.status, 'insufficient_comparables');
  assert.equal(Object.hasOwn(report.statistics_summary, 'price_band'), false);
  assert.equal(report.historical_search.total, 0);
});

test('reports unknown flags and malformed CSV as failures without emitting successful JSON', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tender-report-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'invalid.csv');
  writeFileSync(path, 'wrong,columns\n1,2\n');
  const before = readFileSync(path, 'utf8');
  const malformed = run(['--csv', path]);
  assert.equal(malformed.status, 1);
  assert.equal(malformed.stdout, '');
  assert.match(malformed.stderr, /Tender data report failed:.*CSV columns/);
  assert.equal(readFileSync(path, 'utf8'), before);
  const unknown = run(['--reveal']);
  assert.equal(unknown.status, 1);
  assert.equal(unknown.stdout, '');
  assert.match(unknown.stderr, /Tender data report failed:.*Unknown option/);
});

test('statistics output is explicitly a bounded preview rather than the full snapshot', () => {
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout).statistics_summary;
  assert.equal(summary.comparable_tender_nos_preview.length, 5);
  assert.equal(summary.preview_truncated, true);
  assert.equal(Object.hasOwn(summary, 'comparables'), false);
  assert.match(summary.limitations, /not a bid recommendation/);
});

test('missing CSV and missing flag values fail without successful JSON', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tender-missing-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const missing = run(['--csv', join(directory, 'missing.csv')]);
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, '');
  assert.match(missing.stderr, /Tender data report failed:.*ENOENT/);
  const noValue = run(['--query']);
  assert.equal(noValue.status, 1);
  assert.equal(noValue.stdout, '');
  assert.match(noValue.stderr, /Tender data report failed:.*argument missing/);
});

test('the report command is available through package scripts', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts['data:report'], 'node scripts/tender-report.mjs');
});
