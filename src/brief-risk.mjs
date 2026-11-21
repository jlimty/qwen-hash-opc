// Deterministic risk facts for a submitted brief. These are signals for the admin, computed from
// things the code can check; the level is a sort key, not a verdict. No agent judgement goes in here.

export const riskThresholds = Object.freeze({ thinEvidenceBelow: 15, wideBandRatio: 4, shorthandTolerance: 0.005, listedFigures: 5 });

export function formatSgd(cents) {
  const value = Number(cents) / 100;
  const decimals = Number(cents) % 100 === 0 ? 0 : 2;
  return `S$${value.toLocaleString('en-SG', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

// A number, optionally with a k/m shorthand (not the start of a word) or a percent sign.
const numberToken = /\d(?:[\d,]*\d)?(?:\.\d+)?(?:\s?[kKmM](?![A-Za-z])|%)?/g;

function unmatchedFigures(content, band, n) {
  const dollars = [band.low_cents, band.median_cents, band.high_cents].map((c) => Number(c) / 100);
  const exact = new Set([...dollars, ...dollars.map((d) => d * 100), n]);
  const unmatched = [];
  for (const [raw] of String(content).matchAll(numberToken)) {
    const token = raw.replace(/\s+/g, '');
    if (token.endsWith('%')) { unmatched.push(token); continue; }
    const suffix = /[kKmM]$/.exec(token)?.[0]?.toLowerCase();
    const value = Number(token.replace(/[kKmM]$/, '').replaceAll(',', '')) * (suffix === 'k' ? 1e3 : suffix === 'm' ? 1e6 : 1);
    const ok = suffix
      ? dollars.some((d) => d > 0 && Math.abs(value - d) / d <= riskThresholds.shorthandTolerance)
      : exact.has(value);
    if (!ok) unmatched.push(token);
  }
  return [...new Set(unmatched)];
}

export function computeRiskFacts({ n, band, maxContractCents, content, citedCount, verifiedProjectCount, priorBriefCount }) {
  const facts = [];
  const add = (code, message) => facts.push({ code, message });
  if (n < riskThresholds.thinEvidenceBelow) add('thin_evidence', `Only ${n} comparable contracts.`);
  const low = Number(band.low_cents);
  const high = Number(band.high_cents);
  if (low <= 0) add('wide_band', 'Band is wide: the bottom is S$0.');
  else if (high > riskThresholds.wideBandRatio * low) add('wide_band', `Band is wide: top is ${(high / low).toFixed(1)}× the bottom.`);
  if (Number(band.median_cents) > Number(maxContractCents)) {
    add('above_ceiling', `Median ${formatSgd(band.median_cents)} is above the client's ${formatSgd(maxContractCents)} ceiling.`);
  }
  const figures = unmatchedFigures(content, band, n);
  if (figures.length) {
    const k = figures.length;
    add('unmatched_numbers', `${k} figure${k === 1 ? ' in the text is not a band figure' : 's in the text are not band figures'}: ${figures.slice(0, riskThresholds.listedFigures).join(', ')}.`);
  }
  if (citedCount === 0) add('no_citations', 'No verified project cited.');
  if (priorBriefCount === 0) add('thin_history', 'First brief from this client.');
  else if (verifiedProjectCount < 2) add('thin_history', `Only ${verifiedProjectCount} verified project on record.`);
  const level = facts.length === 0 ? 'low' : facts.length <= 2 ? 'medium' : 'high';
  return { facts, level };
}
