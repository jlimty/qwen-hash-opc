import { createHash } from 'node:crypto';
import { historicalFilterSchema, selectHistoricalContracts } from './tender-catalog.mjs';

const statsFilterSchema = historicalFilterSchema.refine((filters) => filters.query || filters.category,
  'A query or category is required for comparables.');
const compareName = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function percentileCents(sorted, percentile) {
  const position = (sorted.length - 1) * percentile;
  const index = Math.floor(position / 100);
  const remainder = position % 100;
  const lower = BigInt(sorted[index]);
  const upper = BigInt(sorted[Math.min(index + 1, sorted.length - 1)]);
  return Number((lower * BigInt(100 - remainder) + upper * BigInt(remainder) + 50n) / 100n);
}

// includeHoldout (live price checks) adds the 2026 hold-out awards and marks the snapshot scope, so its stat_id never
// collides with a backtest snapshot, whose contents (and stat_id) stay exactly as before.
export const minimumLiveAwardCents = 100000;
export const wideBandRatio = 5;
export const thinBelow = 10;

// A panel or framework appointment is one award shared by many firms (often the same nominal or capped amount each):
// its total is not the price of one contract. Three or more paid winners, or several winners paid the same amount.
export function isPanelAward(contract) {
  const paid = contract.suppliers.filter((supplier) => supplier.awarded_cents > 0);
  return paid.length >= 3 || (paid.length >= 2 && new Set(paid.map((supplier) => supplier.awarded_cents)).size === 1);
}

export function buildStatsSnapshot(dataset, options, { includeHoldout = false } = {}) {
  const filters = Object.freeze(statsFilterSchema.parse(options));
  // Live checks drop nominal awards (panel and schedule-of-rates contracts record values like S$5): they are not prices.
  const floor = includeHoldout ? minimumLiveAwardCents : 1;
  const matched = selectHistoricalContracts(dataset, filters, { includeHoldout }).filter((contract) => contract.total_awarded_cents >= floor);
  // Live checks also leave out panel awards; backtest snapshots keep every award so their figures never move.
  const contracts = matched.filter((contract) => !includeHoldout || !isPanelAward(contract)).sort((a, b) => compareName(a.tender_no, b.tender_no));
  const n = contracts.length;
  const snapshot = {
    dataset_id: dataset.dataset_id,
    dataset_sha256: dataset.dataset_sha256,
    taxonomy_version: dataset.taxonomy_version,
    holdout_from: dataset.holdout_from,
    algorithm_version: 'contract-percentiles-v1',
    ...(includeHoldout && { scope: 'all-awards', minimum_award_cents: minimumLiveAwardCents, excluded_panels: matched.length - contracts.length, wide_band: false, thin: true }),
    method: 'All query token prefixes and exact category/agency filters; contract totals; linear quartiles rounded half-up to cents.',
    limitations: 'Historical award totals are not a bid recommendation; contract scope and duration may differ.',
    filters,
    status: n >= 5 ? 'ready' : 'insufficient_comparables',
    n,
    minimum_comparables: 5,
    currency: 'SGD',
    comparables: Object.freeze(contracts.map((contract) => Object.freeze({
      tender_no: contract.tender_no,
      total_awarded_cents: contract.total_awarded_cents,
      source_records: contract.source_records,
    }))),
  };
  if (n >= 5) {
    const amounts = contracts.map((contract) => contract.total_awarded_cents).sort((a, b) => a - b);
    snapshot.price_band = Object.freeze({
      low_cents: percentileCents(amounts, 25),
      median_cents: percentileCents(amounts, 50),
      high_cents: percentileCents(amounts, 75),
    });
    if (includeHoldout) {
      snapshot.wide_band = snapshot.price_band.high_cents > wideBandRatio * snapshot.price_band.low_cents;
      // Thin evidence: too few awards, or awards too spread out, to put a dollar range on. Shown as context, never priced.
      snapshot.thin = n < thinBelow || snapshot.wide_band;
    }
    const suppliers = new Map();
    const agencies = new Map();
    for (const contract of contracts) {
      agencies.set(contract.agency, (agencies.get(contract.agency) ?? 0) + 1);
      for (const supplier of contract.suppliers.filter((item) => item.awarded_cents > 0)) {
        const previous = suppliers.get(supplier.name);
        suppliers.set(supplier.name, {
          name: supplier.name,
          wins: (previous?.wins ?? 0) + 1,
          latest: previous && previous.latest > contract.last_award_date ? previous.latest : contract.last_award_date,
        });
      }
    }
    const ranking = [...suppliers.values()].sort((a, b) => b.wins - a.wins || compareName(b.latest, a.latest) || compareName(a.name, b.name));
    snapshot.supplier_share_basis = 'fraction-of-comparable-contracts';
    snapshot.top_suppliers = Object.freeze(ranking.slice(0, 10).map(({ name, wins }) => Object.freeze({ name, wins, share: wins / n })));
    snapshot.top_agencies = Object.freeze([...agencies.entries()].sort(([a, ac], [b, bc]) => bc - ac || compareName(a, b))
      .slice(0, 10).map(([name, contracts]) => Object.freeze({ name, contracts, share: contracts / n })));
    snapshot.incumbent_method = 'When an agency is specified: most comparable contract wins, ties by latest award then supplier name; not a confirmed incumbent.';
    snapshot.likely_incumbent = filters.agency && ranking.length
      ? Object.freeze({ name: ranking[0].name, wins: ranking[0].wins }) : null;
  }
  const statId = `stat_${createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')}`;
  return Object.freeze({ stat_id: statId, ...snapshot });
}
