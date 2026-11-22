import assert from 'node:assert/strict';
import { test } from 'node:test';
import { priceChart, winnersChart, yearsChart } from '../src/brief-charts.mjs';

const awards = [20000, 45000, 69780, 72000, 90826, 120000, 400000].map((dollars, i) => ({ cents: dollars * 100, label: `T${i} <Agency & Co>`, year: 2021 + (i % 5) }));
const band = { low_cents: 2187450, median_cents: 6978000, high_cents: 9082600 };

test('the price chart draws one dot per award with a tooltip, the middle half, the median and the suggested range', () => {
  const svg = priceChart({ awards, band, suggested: { from_cents: 2187450, to_cents: 6978000 } });
  assert.match(svg, /^<svg[^>]+viewBox="0 0 \d+ \d+"[^>]+role="img"[^>]+aria-label="[^"]+"/);
  assert.equal((svg.match(/<circle /g) ?? []).length, awards.length);
  assert.match(svg, /<title>T0 &lt;Agency &amp; Co&gt; · S\$20,000<\/title>/);
  assert.match(svg, /class="band"/);
  assert.match(svg, /class="median"/);
  assert.match(svg, /class="suggested"/);
  assert.match(svg, />Suggested range</);
  assert.match(svg, />Middle half of awards</);
  assert.doesNotMatch(svg, /style=/, 'no inline styles: the page CSP forbids them');
});

test('an open-ended suggestion (below the lower quartile) runs to the edge of the chart', () => {
  const svg = priceChart({ awards, band, suggested: { to_cents: 2187450 } });
  assert.match(svg, /class="suggested"/);
});

test('the winners chart labels each supplier with wins out of the total', () => {
  const svg = winnersChart([{ name: 'Alpha <Pte>', wins: 4, share: 4 / 10 }, { name: 'Beta', wins: 2, share: 0.2 }], 10);
  assert.equal((svg.match(/<rect class="bar"/g) ?? []).length, 2);
  assert.match(svg, />Alpha &lt;Pte&gt;</);
  assert.match(svg, />4 of 10</);
});

test('the years chart counts awards per year, oldest first', () => {
  const svg = yearsChart(awards);
  const years = [...svg.matchAll(/>(20\d\d)</g)].map((m) => m[1]);
  assert.deepEqual(years, ['2021', '2022', '2023', '2024', '2025']);
  assert.match(svg, /<title>2021 · 2 awards<\/title>/);
});

test('empty inputs draw nothing', () => {
  assert.equal(priceChart({ awards: [], band }), '');
  assert.equal(winnersChart([], 0), '');
  assert.equal(yearsChart([]), '');
});

test('the price chart says it is a log scale, keys its marks in a legend row, and stacks equal amounts instead of scattering them', () => {
  const svg = priceChart({ awards, band, suggested: { from_cents: 2187450, to_cents: 6978000 } });
  assert.match(svg, />Award amount \(log scale\)</);
  assert.match(svg, /class="legend"/);
  assert.match(svg, />Median S\$69,780</);
  // Dots at different amounts sit on the baseline; equal amounts stack upward.
  const twins = [{ cents: 5000000, label: 'a' }, { cents: 5000000, label: 'b' }, { cents: 9000000, label: 'c' }];
  const ys = [...priceChart({ awards: twins, band }).matchAll(/<circle class="dot" cx="[\d.]+" cy="([\d.]+)"/g)].map((m) => Number(m[1]));
  assert.equal(ys[0], ys[2]);
  assert.ok(ys[1] < ys[0], 'the second equal award stacks above the first');
});

test('price chart tick labels never overlap', () => {
  const spread = [1200, 1800, 2500, 4000, 9000, 15000, 60000, 250000, 900000, 3000000].map((d, i) => ({ cents: d * 100, label: `x${i}` }));
  const svg = priceChart({ awards: spread, band: { low_cents: 250000, median_cents: 1200000, high_cents: 25000000 } });
  const xs = [...svg.matchAll(/<text class="tick" x="([\d.]+)"/g)].map((m) => Number(m[1])).sort((a, b) => a - b);
  assert.ok(xs.length >= 2);
  for (let i = 1; i < xs.length; i++) assert.ok(xs[i] - xs[i - 1] >= 48, `ticks ${xs[i - 1]} and ${xs[i]} are too close`);
});
