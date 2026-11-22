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
