// Deterministic risk facts for a submitted brief. These are signals for the admin, computed from
// things the code can check; the level is a sort key, not a verdict. No agent judgement goes in here.

export const riskThresholds = Object.freeze({ thinEvidenceBelow: 15, wideBandRatio: 4, shorthandTolerance: 0.005, listedFigures: 5 });

export function formatSgd(cents) {
  const value = Number(cents) / 100;
  const decimals = Number(cents) % 100 === 0 ? 0 : 2;
  return `S$${value.toLocaleString('en-SG', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

// Customer-facing figures are whole dollars: cents on a six-figure award are noise, and mixing both reads as sloppy.
export function wholeSgd(cents) {
  return `S$${Math.round(Number(cents) / 100).toLocaleString('en-SG')}`;
}

// Thin evidence gets no quartiles: only the span of awards, rounded to two significant figures, so it can't read as precise.
export function roughSgd(cents) {
  const dollars = Number(cents) / 100;
  const two = (v) => Number(v.toPrecision(2));
  return dollars >= 1e6 ? `S$${two(dollars / 1e6)}M` : dollars >= 1e3 ? `S$${two(dollars / 1e3)}k` : `S$${two(dollars)}`;
}
export function roughSpread(cents) {
  const values = cents.map(Number).filter((v) => v > 0);
  if (!values.length) return '';
  return `from about ${roughSgd(Math.min(...values))} to ${roughSgd(Math.max(...values))}`;
}

// A standalone number (never digits inside a word or code such as a tender number), optionally
// followed by a k / m / million shorthand or a percent sign.
const numberToken = /(?<![A-Za-z\d.])(\d(?:[\d,]*\d)?(?:\.\d+)?)(?:\s?(million|mil|[kKmM])(?![A-Za-z])|(%)|(?![A-Za-z\d]))/g;

export function unmatchedFigures(content, band, n) {
  const cents = [band.low_cents, band.median_cents, band.high_cents].map(Number);
  const dollars = cents.map((c) => c / 100);
  // Exact matches: dollars as written, rounded or truncated to whole dollars, raw cents, and n.
  const exact = new Set([...dollars, ...dollars.map(Math.round), ...dollars.map(Math.floor), ...cents, n]);
  const unmatched = [];
  for (const [raw, digits, word, percent] of String(content).matchAll(numberToken)) {
    const token = raw.replace(/\s+/g, '');
    if (percent) { unmatched.push(token); continue; }
    const suffix = word ? (word.toLowerCase() === 'k' ? 'k' : 'm') : undefined;
    const value = Number(digits.replaceAll(',', '')) * (suffix === 'k' ? 1e3 : suffix === 'm' ? 1e6 : 1);
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
