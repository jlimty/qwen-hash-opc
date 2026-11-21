import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { parseTenderCsv, tenderCategories } from '../src/tender-data.mjs';
import { getIncomingTenders, searchHistoricalTenders } from '../src/tender-catalog.mjs';
import { buildStatsSnapshot } from '../src/tender-stats.mjs';

try {
  const { values } = parseArgs({
    options: { csv: { type: 'string' }, query: { type: 'string' }, category: { type: 'string' }, agency: { type: 'string' } },
    strict: true,
    allowPositionals: false,
  });
  const path = values.csv ?? new URL('../data/GovernmentProcurementviaGeBIZ.csv', import.meta.url);
  const dataset = parseTenderCsv(readFileSync(path, 'utf8'));
  const filters = {
    query: values.query ?? (values.category ? undefined : 'event management'),
    agency: values.agency,
    category: values.category,
  };
  const snapshot = buildStatsSnapshot(dataset, filters);
  const dates = dataset.rows.map((row) => row.award_date).sort();
  const report = {
    title: 'Tender Desk historical-data report',
    purpose: 'Local developer report, not client-facing pricing advice.',
    dataset: {
      id: dataset.dataset_id,
      sha256: dataset.dataset_sha256,
      source: 'Government Procurement via GeBIZ — Ministry of Finance, Singapore',
      source_url: `https://data.gov.sg/api/action/datastore_search?resource_id=${dataset.dataset_id}`,
      taxonomy_version: dataset.taxonomy_version,
      source_rows: dataset.rows.length,
      contracts: dataset.contracts.length,
      historical_contracts: dataset.contracts.filter((contract) => !contract.is_holdout).length,
      holdout_contracts: dataset.contracts.filter((contract) => contract.is_holdout).length,
      holdout_from: dataset.holdout_from,
      first_award_date: dates[0],
      last_award_date: dates.at(-1),
    },
    categories: tenderCategories.map((category) => {
      const contracts = dataset.contracts.filter((contract) => contract.category === category);
      return {
        category,
        historical_contracts: contracts.filter((contract) => !contract.is_holdout).length,
        eligible_price_contracts: contracts.filter((contract) => !contract.is_holdout && contract.total_awarded_cents > 0).length,
        incoming_tenders: contracts.filter((contract) => contract.is_holdout).length,
      };
    }),
    historical_search: searchHistoricalTenders(dataset, { ...filters, limit: 5 }),
    incoming_sample: getIncomingTenders(dataset, { category: values.category, limit: 3 }),
    statistics_summary: {
      stat_id: snapshot.stat_id,
      filters: snapshot.filters,
      status: snapshot.status,
      n: snapshot.n,
      minimum_comparables: snapshot.minimum_comparables,
      currency: snapshot.currency,
      price_band: snapshot.price_band,
      top_suppliers: snapshot.top_suppliers,
      top_agencies: snapshot.top_agencies,
      likely_incumbent: snapshot.likely_incumbent,
      comparable_tender_nos_preview: snapshot.comparables.slice(0, 5).map((contract) => contract.tender_no),
      preview_truncated: snapshot.n > 5,
      method: snapshot.method,
      limitations: snapshot.limitations,
    },
  };
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(`Tender data report failed: ${error.message}`);
  process.exitCode = 1;
}
