import { buildStatsSnapshot } from './tender-stats.mjs';

export const backtestMethod = 'backtest-v1: band from same-category, same-agency comparables (fallback: same category); likely incumbent only from the agency tier. Hold-out contracts are never comparables.';

export function buildBacktest(dataset) {
  const cache = new Map();
  const snapshot = (filters) => {
    const key = JSON.stringify(filters);
    if (!cache.has(key)) cache.set(key, buildStatsSnapshot(dataset, filters));
    return cache.get(key);
  };
  const predictions = new Map();
  let unscoreable = 0;
  for (const contract of dataset.contracts) {
    if (!contract.is_holdout) continue;
    if (contract.total_awarded_cents <= 0) { unscoreable++; continue; }
    let tier = 'agency';
    let stats = snapshot({ category: contract.category, agency: contract.agency.toLowerCase() });
    if (stats.status !== 'ready') { tier = 'category'; stats = snapshot({ category: contract.category }); }
    if (stats.status !== 'ready') { unscoreable++; continue; }
    predictions.set(contract.tender_no, Object.freeze({
      tender_no: contract.tender_no, description: contract.description, agency: contract.agency, category: contract.category,
      tier, n: stats.n, stat_id: stats.stat_id, band: stats.price_band, incumbent: stats.likely_incumbent?.name ?? null,
      actual_cents: contract.total_awarded_cents, actual_suppliers: contract.suppliers.map((supplier) => supplier.name),
    }));
  }
  return Object.freeze({ predictions, scoreable: predictions.size, unscoreable });
}

export function scoreRow(prediction) {
  const { actual_cents: actual, band } = prediction;
  return {
    in_band: actual >= band.low_cents && actual <= band.high_cents,
    incumbent_won: prediction.incumbent === null ? null : prediction.actual_suppliers.includes(prediction.incumbent),
  };
}

export function summarize(revealed, backtest) {
  const rows = revealed.map((prediction) => ({ prediction, ...scoreRow(prediction) }));
  const withIncumbent = rows.filter((row) => row.incumbent_won !== null);
  const rate = (hits, total) => (total ? hits / total : null);
  return {
    revealed: rows.length, scoreable: backtest.scoreable, unscoreable: backtest.unscoreable,
    band_hits: rows.filter((row) => row.in_band).length, band_rate: rate(rows.filter((row) => row.in_band).length, rows.length),
    incumbent_scored: withIncumbent.length, incumbent_hits: withIncumbent.filter((row) => row.incumbent_won).length,
    incumbent_rate: rate(withIncumbent.filter((row) => row.incumbent_won).length, withIncumbent.length),
    rows,
  };
}

export const backtestToJson = (backtest, dataset) => ({
  dataset_sha256: dataset.dataset_sha256, scoreable: backtest.scoreable, unscoreable: backtest.unscoreable, predictions: [...backtest.predictions.values()],
});

export function backtestFromJson(json, dataset) {
  if (json.dataset_sha256 !== dataset.dataset_sha256) throw new Error('The precomputed backtest does not match this dataset.');
  return Object.freeze({
    predictions: new Map(json.predictions.map((prediction) => [prediction.tender_no, Object.freeze(prediction)])),
    scoreable: json.scoreable, unscoreable: json.unscoreable,
  });
}
