// The free instant price check: comparable past awards for a tender's search terms, over all award history
// (including the 2026 hold-out rows). Every figure comes from buildStatsSnapshot; nothing here is estimated.
// There is no category-only fallback: a band over a whole category is not comparable work, so no matching terms
// means too few comparables.
import { createHash } from 'node:crypto';
import { buildStatsSnapshot } from './tender-stats.mjs';

export const priceLimits = 'Past awards from April 2021 to March 2026. Not a quote, and not a winning price. GeBIZ publishes winning amounts only.';
const maxListed = 25;

export function cleanTerms(terms) {
  const list = Array.isArray(terms) ? terms : String(terms ?? '').split(',');
  return [...new Set(list.map((term) => String(term ?? '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40))
    .filter((term) => term.length >= 2))].slice(0, 3);
}

// One rule for the free check and the paid brief: each query is tried with the tender's category first and then
// without it, so a misfiled category can't hide real comparables; 'other' is a catch-all and never a filter.
export function priceCheck(dataset, { terms, category, agency } = {}) {
  const cleaned = cleanTerms(terms);
  const queries = [...new Set([cleaned.join(' '), cleaned[0]].filter(Boolean))];
  const narrow = category && category !== 'other' ? category : undefined;
  const attempts = queries.flatMap((query) => [...(narrow ? [narrow] : []), undefined].map((filter) => ({ query, snapshot: buildStatsSnapshot(dataset,
    { query, ...(filter && { category: filter }), ...(agency && { agency: String(agency).toLowerCase() }) }, { includeHoldout: true }) })));
  if (!attempts.length) {
    return { status: 'insufficient_comparables', query_used: null, snapshot: { n: 0, status: 'insufficient_comparables' }, comparables: [], limits: priceLimits };
  }
  const chosen = attempts.find((attempt) => attempt.snapshot.status === 'ready') ?? attempts[0];
  const byNumber = new Map(dataset.contracts.map((contract) => [contract.tender_no, contract]));
  const comparables = chosen.snapshot.comparables.map(({ tender_no }) => byNumber.get(tender_no)).filter(Boolean)
    .sort((a, b) => (a.last_award_date === b.last_award_date ? (a.tender_no < b.tender_no ? -1 : 1) : a.last_award_date > b.last_award_date ? -1 : 1))
    .slice(0, maxListed)
    .map((contract) => ({ tender_no: contract.tender_no, description: contract.description, agency: contract.agency, award_date: contract.last_award_date,
      awarded_cents: contract.total_awarded_cents, suppliers: contract.suppliers.filter((s) => s.awarded_cents > 0).map((s) => s.name) }));
  return { status: chosen.snapshot.status, query_used: chosen.query, snapshot: chosen.snapshot, comparables, limits: priceLimits };
}

const words = (text) => new Set((String(text ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((word) => word.length >= 4));

export function fitFacts({ client, verifiedProjects = [], tender, check }) {
  const queryWords = words(check?.query_used);
  return {
    category_match: Boolean(tender?.category && client?.categories?.includes(tender.category)),
    within_capacity: check?.status === 'ready' ? Number(check.snapshot.price_band.median_cents) <= Number(client.max_contract_cents) : null,
    related_projects: verifiedProjects.filter((project) => [...words(project.title)].some((word) => queryWords.has(word))).length,
  };
}

export function pastedTenderNo({ title, agency }) {
  const normal = (value) => String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  return `PASTED-${createHash('sha256').update(`${normal(agency)}|${normal(title)}`).digest('hex').slice(0, 16)}`;
}
