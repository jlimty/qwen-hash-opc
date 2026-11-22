// Server-drawn SVG charts for the paid brief. No client JavaScript (the page CSP allows none) and no inline styles:
// colours come from classes styled in the app's stylesheet, and every mark carries a native <title> tooltip.
import { roughSpread, wholeSgd } from './brief-risk.mjs';
import { esc } from './console-view.mjs';

const W = 640;

function niceTicks(min, max) {
  const ticks = [];
  for (let exp = Math.floor(Math.log10(min)); exp <= Math.ceil(Math.log10(max)); exp++) {
    for (const step of [1, 2, 5]) {
      const v = step * 10 ** exp;
      if (v >= min * 0.999 && v <= max * 1.001) ticks.push(v);
    }
  }
  return ticks.length > 6 ? ticks.filter((v) => /^1/.test(String(v))) : ticks;
}
const shortSgd = (dollars) => (dollars >= 1e6 ? `S$${+(dollars / 1e6).toFixed(1)}M` : dollars >= 1e3 ? `S$${Math.round(dollars / 1e3)}k` : `S$${dollars}`);

// Award amounts on a log scale (awards span orders of magnitude), said so under the axis. Each dot sits on the baseline
// at its amount; dots that would overlap stack upward, so height means "more awards here" and nothing else. The middle
// half of awards is shaded, the median is a line, the suggested range is outlined, and a legend row keys all three
// above the plot so no label ever sits on the data.
export function priceChart({ awards, band, suggested, thin = false }) {
  if (!awards?.length || !band) return '';
  const values = awards.map((a) => a.cents / 100).filter((v) => v > 0);
  const lo = Math.min(...values, band.low_cents / 100) * 0.8;
  const hi = Math.max(...values, band.high_cents / 100) * 1.25;
  const left = 16; const right = W - 16; const top = 34; const plotH = 84; const axisY = top + plotH;
  const x = (dollars) => left + ((Math.log10(dollars) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo))) * (right - left);
  const q1 = x(band.low_cents / 100); const q3 = x(band.high_cents / 100); const med = x(band.median_cents / 100);
  const hasRange = Boolean(suggested && (suggested.from_cents || suggested.to_cents));
  const parts = [];
  // Legend row: fixed slots, so its labels never collide with each other or with the marks. Thin evidence draws the
  // awards only: quartiles and a median from a handful of awards would look more precise than they are.
  if (thin) parts.push(`<g class="legend"><rect class="dot" x="${left + 1}" y="6" width="10" height="10" rx="5"/><text class="label muted" x="${left + 18}" y="15">Each dot is one past award</text></g>`);
  else parts.push(`<g class="legend"><rect class="band" x="${left}" y="6" width="14" height="10" rx="2"/><text class="label muted" x="${left + 20}" y="15">Middle half of awards</text>`,
    `<line class="median" x1="${left + 186}" x2="${left + 186}" y1="4" y2="18"/><text class="label" x="${left + 194}" y="15">Median ${esc(wholeSgd(band.median_cents))}</text>`,
    hasRange ? `<rect class="suggested" x="${left + 380}" y="6" width="14" height="10" rx="2"/><text class="label strong" x="${left + 400}" y="15">Suggested range</text>` : '', '</g>');
  if (hasRange && !thin) {
    const a = suggested.from_cents ? x(suggested.from_cents / 100) : left;
    const b = suggested.to_cents ? x(suggested.to_cents / 100) : right;
    parts.push(`<rect class="suggested" x="${a.toFixed(1)}" y="${top - 4}" width="${Math.max(2, b - a).toFixed(1)}" height="${plotH + 4}" rx="4"/>`);
  }
  if (!thin) parts.push(`<rect class="band" x="${q1.toFixed(1)}" y="${top}" width="${Math.max(2, q3 - q1).toFixed(1)}" height="${plotH}" rx="4"/>`,
    `<line class="median" x1="${med.toFixed(1)}" x2="${med.toFixed(1)}" y1="${top}" y2="${axisY}"/>`);
  // Stack, cheapest first: each dot takes the lowest level with no neighbour within a dot's width.
  const levels = [];
  const dots = awards.map((award, i) => ({ award, i, cx: x(award.cents / 100), cy: axisY - 7 }));
  [...dots].sort((a, b) => a.cx - b.cx || a.i - b.i).forEach((dot) => {
    let level = 0;
    while ((levels[level] ?? []).some((cx) => Math.abs(cx - dot.cx) < 10) && level < 6) level++;
    (levels[level] ??= []).push(dot.cx);
    dot.cy = axisY - 7 - level * 11;
  });
  for (const { award, cx, cy } of dots) {
    parts.push(`<circle class="dot" cx="${cx.toFixed(1)}" cy="${cy}" r="5"><title>${esc(award.label)} · ${esc(wholeSgd(award.cents))}</title></circle>`);
  }
  parts.push(`<line class="axis" x1="${left}" x2="${right}" y1="${axisY}" y2="${axisY}"/>`);
  let lastTick = -Infinity;
  for (const tick of niceTicks(lo, hi)) {
    const at = x(tick);
    if (at - lastTick < 48) continue;
    lastTick = at;
    parts.push(`<text class="tick" x="${at.toFixed(1)}" y="${axisY + 16}" text-anchor="middle">${shortSgd(tick)}</text>`);
  }
  parts.push(`<text class="label muted" x="${right}" y="${axisY + 34}" text-anchor="end">Award amount (log scale)</text>`);
  const summary = thin ? `${awards.length} comparable awards ${roughSpread(awards.map((a) => a.cents))}`
    : `${awards.length} comparable awards from ${wholeSgd(Math.min(...values) * 100)} to ${wholeSgd(Math.max(...values) * 100)}; median ${wholeSgd(band.median_cents)}`;
  return `<svg class="chart" viewBox="0 0 ${W} ${axisY + 42}" role="img" aria-label="${esc(summary)}">${parts.join('')}</svg>`;
}

// Who won the comparable awards most often: one bar per supplier, share of all comparable awards.
export function winnersChart(winners, n) {
  if (!winners?.length || !n) return '';
  // Drawn narrower than the price chart: it sits in a half-width column, and a narrower viewBox keeps the labels readable.
  const width = 420; const rowH = 30; const labelW = 190; const barMax = width - labelW - 60;
  const rows = winners.slice(0, 5).map((w, i) => {
    const y = i * rowH + 8; const width = Math.max(4, (w.wins / n) * barMax);
    return `<text class="label" x="${labelW - 8}" y="${y + 15}" text-anchor="end">${esc(w.name.length > 20 ? `${w.name.slice(0, 19).trimEnd()}…` : w.name)}</text>
<rect class="bar" x="${labelW}" y="${y + 3}" width="${width.toFixed(1)}" height="16" rx="4"><title>${esc(w.name)} · won ${w.wins} of ${n}</title></rect>
<text class="tick" x="${(labelW + width + 8).toFixed(1)}" y="${y + 15}">${w.wins} of ${n}</text>`;
  });
  return `<svg class="chart" viewBox="0 0 ${width} ${winners.slice(0, 5).length * rowH + 12}" role="img" aria-label="${esc(`Most frequent winners of ${n} comparable awards`)}">${rows.join('')}</svg>`;
}

// How many comparable awards there were each year: shows whether this kind of work is bought steadily.
export function yearsChart(awards) {
  const counts = new Map();
  for (const award of awards ?? []) if (award.year) counts.set(String(award.year), (counts.get(String(award.year)) ?? 0) + 1);
  if (!counts.size) return '';
  // Every year from the first to the last, including years with no awards, so a gap shows as a gap.
  const known = [...counts.keys()].map(Number).filter(Number.isInteger).sort((a, b) => a - b);
  const years = known.length ? Array.from({ length: known.at(-1) - known[0] + 1 }, (_, i) => String(known[0] + i)) : [...counts.keys()].sort();
  for (const year of years) if (!counts.has(year)) counts.set(year, 0);
  const max = Math.max(1, ...counts.values()); const plotH = 70; const step = Math.min(70, 380 / years.length); const barW = step * 0.6;
  const bars = years.map((year, i) => {
    const h = Math.max(3, (counts.get(year) / max) * plotH); const x = 20 + i * step;
    return `<rect class="bar" x="${x.toFixed(1)}" y="${(plotH - h + 18).toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="4"><title>${year} · ${counts.get(year)} award${counts.get(year) === 1 ? '' : 's'}</title></rect>
<text class="tick" x="${(x + barW / 2).toFixed(1)}" y="${(plotH - h + 12).toFixed(1)}" text-anchor="middle">${counts.get(year)}</text>
<text class="label" x="${(x + barW / 2).toFixed(1)}" y="${plotH + 34}" text-anchor="middle">${year}</text>`;
  });
  return `<svg class="chart" viewBox="0 0 ${Math.max(300, 40 + years.length * step)} ${plotH + 40}" role="img" aria-label="Comparable awards per year">${bars.join('')}</svg>`;
}

export const chartCss = `
.chart{width:100%;height:auto;display:block;font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
.chart .dot{fill:#2457D6;stroke:#fff;stroke-width:2}
.chart .dot:hover{fill:#1B45B0}
.chart .bar{fill:#2457D6}
.chart .band{fill:#EAF0FD}
.chart .suggested{fill:none;stroke:#1A6B3F;stroke-width:2;stroke-dasharray:6 4}
.chart .median{stroke:#0F1A2B;stroke-width:2}
.chart .axis{stroke:#C9D1DB;stroke-width:1}
.chart .label{fill:#0F1A2B}
.chart .label.strong{font-weight:650;fill:#1A6B3F}
.chart .label.muted,.chart .tick{fill:#58647A}
`;
