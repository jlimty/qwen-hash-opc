// HTML for the customer web app (the AI tender assistant). Server-rendered, no client JavaScript. Every link is written
// from the app root ("/home") and rewritten to the deployed base path by the handler.
import { formatSgd, roughSpread, wholeSgd } from './brief-risk.mjs';
import { thinText } from './brief-drafting.mjs';
import { esc, plural } from './console-view.mjs';
import { priceLimits } from './price-check.mjs';
import { renderBriefHtml } from './brief-render.mjs';
import { chartCss, priceChart, winnersChart, yearsChart } from './brief-charts.mjs';
import { tenderCategories } from './tender-data.mjs';

export const assistantCss = chartCss + `
.top{display:flex;align-items:center;gap:1rem;justify-content:space-between;padding:.75rem 1.5rem;border-bottom:1px solid var(--line);background:var(--side)}
.top nav{display:flex;align-items:center;gap:.75rem;flex-wrap:wrap}
.top nav a{color:#2A364A;font-weight:500}
.top nav form{margin:0}
.wrap{max-width:64rem;margin:0 auto;padding:1.5rem 1.5rem 4rem;display:grid;gap:1.25rem}
.hero h1{font-size:1.75rem}
.hero p{color:var(--muted);max-width:60ch;margin-top:.35rem}
.form{display:grid;gap:.6rem;padding:1rem}
.form label{font-weight:600;font-size:.875rem}
.form input,.form select{font:inherit;min-height:2.375rem;padding:0 .7rem;border:1px solid var(--line-strong);border-radius:6px;background:#fff;color:var(--ink)}
.form input:focus-visible,.form select:focus-visible{outline:2px solid var(--accent);border-color:var(--accent)}
.form .hint{font-size:.8125rem;color:var(--muted)}
.form fieldset{border:1px solid var(--line);border-radius:8px;padding:.75rem;display:grid;gap:.5rem}
.form legend{font-weight:600;font-size:.875rem;padding:0 .25rem}
.cats{display:flex;flex-wrap:wrap;gap:.5rem 1rem}
.cats label{font-weight:400;display:flex;gap:.35rem;align-items:center}
.proj{display:grid;grid-template-columns:2fr 1fr 1.2fr;gap:.5rem;padding:.5rem 0;border-bottom:1px solid var(--line)}
.proj input:first-child{grid-column:1/-1}
.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border-bottom:1px solid var(--line)}
.stat.wide{grid-column:1/-1}
.stat{padding:.9rem 1rem;display:grid;gap:.1rem}
.stat+.stat{border-left:1px solid var(--line)}
.stat .big{font-size:1.4rem;font-weight:650;font-variant-numeric:tabular-nums}
.stat .label{font-size:.8125rem;color:var(--muted)}
.limits{font-size:.8125rem;color:var(--muted);padding:.65rem 1rem;background:var(--side);border-top:1px solid var(--line);border-radius:0 0 10px 10px}
.tenders li{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:1rem;align-items:center;padding:.85rem 1rem;border-bottom:1px solid var(--line)}
.tenders li:last-child{border-bottom:0}
.tenders strong{display:block;font-weight:600;overflow-wrap:anywhere}
.tenders .meta{display:block;font-size:.8125rem;color:var(--muted);overflow-wrap:anywhere}
.testmode{border:1px dashed var(--warn);background:var(--warn-bg);color:var(--warn);border-radius:8px;padding:.6rem .9rem;font-weight:600}
.narrow{max-width:30rem}
.report{display:grid;gap:1.25rem}
.report-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:1.25rem}
.callout{padding:1rem 1.25rem;display:grid;gap:.35rem}
.callout .range{font-size:1.75rem;font-weight:650;letter-spacing:-.01em;font-variant-numeric:tabular-nums}
.callout .label{font-size:.75rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--muted)}
.chart-wrap{padding:.75rem 1rem 1rem}
.scorecard{display:flex;gap:.5rem;flex-wrap:wrap;padding:.75rem 1rem 0}
.reqs li{display:grid;grid-template-columns:7.5rem minmax(0,1fr);gap:.75rem;padding:.65rem 1rem;border-bottom:1px solid var(--line)}
.reqs li:last-child{border-bottom:0}
.reqs .evidence{display:block;font-size:.8125rem;color:var(--muted)}
.bullets{list-style:disc;padding:.75rem 1rem .75rem 2.25rem;display:grid;gap:.4rem;max-width:72ch}
details.awards summary{cursor:pointer;padding:.75rem 1rem;font-weight:600;color:var(--accent-dark)}
@media (max-width:760px){.report-row{grid-template-columns:1fr}.reqs li{grid-template-columns:1fr}}
.plus{color:var(--ok);font-weight:650}.minus{color:var(--muted);font-weight:650}
.credit-pill{font-weight:600;color:var(--accent-dark)}
.steps{display:flex;gap:.5rem;list-style:none;padding:0;margin:0;flex-wrap:wrap}
.steps li{flex:1;min-width:8rem;padding:.55rem .8rem;border:1px solid var(--line);border-radius:8px;color:var(--muted);font-weight:600;font-size:.875rem}
.steps li.done{border-color:#A9D3BA;background:var(--ok-bg);color:var(--ok)}
.steps li.current{border-color:var(--accent);background:var(--tint);color:var(--accent-dark)}
.steps li.current.waiting{border-color:#E8C27A;background:var(--warn-bg);color:var(--warn)}
.inset-banner{margin:.75rem 1rem 0}
.tick{display:flex;gap:.5rem;align-items:flex-start;font-weight:500}
.inset{padding:.75rem 1rem 0}
.brief{padding:.5rem 1rem 1rem;max-width:72ch}
.brief h3{font-size:.9375rem;font-weight:650;margin:1rem 0 .35rem}
.brief p{margin:0 0 .5rem}
.brief ul{list-style:disc;padding-left:1.25rem;display:grid;gap:.35rem}
.verdict{display:flex;flex-direction:column;gap:.1rem;padding:1rem 1.25rem;border-bottom:1px solid var(--line);border-radius:10px 10px 0 0}
.verdict .label{font-size:.75rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase}
.verdict strong{font-size:1.5rem;font-weight:650}
.verdict.bid{background:var(--ok-bg);color:var(--ok)}
.verdict.nobid{background:var(--warn-bg);color:var(--warn)}
.wrap.wide{max-width:74rem;gap:2.75rem}
.ck-head{display:grid;gap:.35rem;max-width:62rem}.ck-head h1{font-size:1.75rem;line-height:1.2;letter-spacing:-.02em;text-wrap:balance}
.ck-grid{display:grid;grid-template-columns:minmax(0,1fr) 20rem;gap:1.5rem;align-items:start}
.ck-main{display:grid;gap:1.25rem;min-width:0}
.ck-answer{padding:1.5rem 1.5rem 1rem}
.ck-lead{color:var(--muted);font-size:.9375rem}
.ck-range{font-size:2.25rem;line-height:1.2;font-weight:650;letter-spacing:-.025em;margin-top:.15rem}
.ck-range.ck-thin{font-size:1.5rem}
.ck-sub{margin-top:.5rem;color:var(--muted);max-width:60ch}.ck-sub strong{color:var(--ink);font-weight:650}
.ck-answer .banner{margin:.85rem 0 0}
.ck-chart{margin-top:1rem}
.ck-who{margin-top:.75rem;font-size:.8125rem;color:var(--muted);max-width:70ch}
.ck-refine{border-top:1px solid var(--line)}
.ck-refine summary,.ck-awards summary{cursor:pointer;padding:.85rem 1.5rem;font-size:.875rem;font-weight:550;color:var(--accent-dark)}
.ck-refine .form{padding:0 1.5rem 1.25rem}
.ck-awards .table-wrap{border-top:1px solid var(--line)}
.ck-limits{font-size:.75rem;color:var(--muted)}
.ck-offer{padding:1.25rem;display:grid;gap:.75rem;position:sticky;top:1rem}
.ck-offer h2{font-size:1.0625rem}
.ck-offer>p{font-size:.875rem;color:var(--muted);line-height:1.6}
.ck-next{display:grid;gap:.4rem}.ck-next .btn,.ck-next button{width:100%;justify-content:center;min-height:2.75rem;font-size:.9375rem}
@media (max-width:900px){.ck-grid{grid-template-columns:1fr}.ck-offer{position:static}}
@media (max-width:760px){.ck-range{font-size:1.75rem}.ck-answer{padding:1.25rem 1rem .75rem}.ck-refine summary,.ck-awards summary{padding:.85rem 1rem}.ck-refine .form{padding:0 1rem 1rem}}
.lp-hero{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,1fr);gap:3.5rem;align-items:center;padding-top:1.5rem}
.lp-h1{font-size:2.5rem;line-height:1.12;letter-spacing:-.03em;max-width:16ch;text-wrap:balance}
.lp-intro{margin-top:1rem;color:var(--muted);font-size:1.0625rem;line-height:1.6;max-width:52ch}
.lp-hero .banner{margin:1.25rem 0 0}
.lp-check{margin-top:1.5rem}
.lp-check label{display:block;font-weight:600;font-size:.875rem;margin-bottom:.5rem}
.lp-input-row{display:flex;gap:.5rem}
.lp-input-row input{flex:1;min-width:0;font:inherit;height:3rem;padding:0 .8rem;border:1px solid var(--muted);border-radius:6px;color:var(--ink);background:#fff}
.lp-input-row input::placeholder{color:var(--muted);opacity:1}
.lp-input-row input:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.lp-input-row button{min-height:3rem;padding:0 1.25rem;font-size:.9375rem}
.lp-note{margin-top:.6rem;font-size:.8125rem;color:var(--ok);font-weight:500}
.lp-paste{margin-top:1rem}
.lp-paste summary{cursor:pointer;font-size:.875rem;font-weight:500;color:var(--accent-dark)}
.lp-paste-form{padding:.75rem 0 0}
.lp-example{overflow:hidden}
.lp-tag{background:var(--tint);color:var(--accent-dark);font-size:.75rem;font-weight:650;padding:.15rem .5rem;border-radius:4px}
.lp-example-body{padding:1.25rem}
.lp-example-title{font-weight:600}
.lp-caption{margin-top:1.1rem;color:var(--muted);font-size:.8125rem}
.lp-range{font-size:1.75rem;font-weight:650;letter-spacing:-.02em;line-height:1.3}
.lp-band{display:block;width:100%;height:auto;margin:1rem 0 .25rem}
.lp-band .track{fill:var(--hover)}.lp-band .mid{fill:var(--tint);stroke:var(--accent)}
.lp-band circle{fill:#fff;stroke:var(--ink);stroke-width:1.25}.lp-band .med{stroke:var(--accent-dark);stroke-width:3}
.lp-facts{display:flex;justify-content:space-between;gap:1rem;margin-top:1rem;padding-top:.9rem;border-top:1px solid var(--line)}
.lp-facts dt{font-size:.75rem;color:var(--muted)}.lp-facts dd{font-size:1.0625rem;font-weight:650}
.lp-example-foot{background:var(--side);border-top:1px solid var(--line);padding:.75rem 1.25rem;font-size:.75rem;color:var(--muted)}
.lp-section-head{display:flex;justify-content:space-between;align-items:baseline;gap:1rem;margin-bottom:.85rem}
.lp-section-head h2,.lp-how h2{font-size:1.375rem;letter-spacing:-.02em}
.lp-section-head p{font-size:.8125rem;color:var(--muted)}
.lp-list li+li{border-top:1px solid var(--line)}
.lp-list form{margin:0}
.lp-row{all:unset;box-sizing:border-box;width:100%;cursor:pointer;display:grid;grid-template-columns:5rem minmax(0,1fr) 9rem 1.125rem;gap:1.25rem;align-items:center;padding:1rem 1.25rem}
.lp-row:hover{background:var(--side)}
.lp-row:focus-visible{outline:2px solid var(--accent);outline-offset:-3px;border-radius:8px}
.lp-close{display:grid;align-self:start}.lp-close strong{font-size:1rem;font-weight:650}.lp-close span{font-size:.75rem;color:var(--muted)}
.lp-title{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-weight:600;line-height:1.4}
.lp-meta{display:flex;flex-wrap:wrap;align-items:center;gap:.3rem .6rem;margin-top:.35rem;font-size:.75rem;color:var(--muted)}
.lp-kind{background:var(--hover);border-radius:4px;padding:.1rem .45rem;font-weight:650}
.lp-ref{font-size:.75rem}
.lp-median{text-align:right}.lp-median strong{display:block;font-weight:650}.lp-median span{font-size:.75rem;color:var(--muted)}

.lp-cta{color:var(--accent-dark);font-size:.8125rem;font-weight:550;text-align:right}
.lp-arrow{width:1.125rem;height:1.125rem;color:var(--accent)}
.lp-more{border-top:1px solid var(--line)}
.lp-more summary{cursor:pointer;padding:.85rem 1.25rem;font-size:.875rem;font-weight:550;color:var(--accent-dark)}
.lp-more .lp-list{border-top:1px solid var(--line)}
.lp-foot{padding:.75rem 1.25rem;border-top:1px solid var(--line);font-size:.75rem;color:var(--muted)}
.lp-steps{list-style:none;padding:0;margin-top:1.25rem;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:2rem;counter-reset:step}
.lp-steps li{position:relative;padding-left:2.25rem;counter-increment:step}
.lp-steps li::before{content:counter(step);position:absolute;left:0;top:0;width:1.5rem;height:1.5rem;display:grid;place-items:center;background:var(--tint);color:var(--accent-dark);border-radius:6px;font-size:.75rem;font-weight:650}
.lp-steps h3{font-size:1rem;font-weight:650}
.lp-steps p{margin-top:.35rem;font-size:.875rem;color:var(--muted);line-height:1.6;max-width:36ch}
.lp-sample{margin-top:1.5rem;font-weight:600}
.lp-pricing{display:grid;grid-template-columns:1.2fr 2fr;gap:2rem;align-items:center;background:var(--side);border:1px solid var(--line);border-radius:10px;padding:1.5rem}
.lp-pricing h2{font-size:1.25rem;letter-spacing:-.015em}
.lp-pricing p{font-size:.8125rem;color:var(--muted);margin-top:.35rem}
.lp-pricing p .btn{margin-top:.6rem}
.lp-prices{display:grid;grid-template-columns:repeat(auto-fit,minmax(7rem,1fr));gap:1.25rem}
.lp-prices>div{border-left:1px solid var(--line-strong);padding-left:1.25rem}
.lp-prices dt{font-size:.8125rem;color:var(--muted)}.lp-prices dd{font-size:1.5rem;font-weight:650;letter-spacing:-.02em}
.lp-prices small{font-size:.75rem;color:var(--muted)}
.lp-proof{display:grid;grid-template-columns:1fr 1fr;gap:3rem;padding-bottom:1rem}
.lp-proof h2{font-size:.9375rem}
.lp-proof p{margin-top:.35rem;font-size:.8125rem;line-height:1.65;color:var(--muted);max-width:62ch}
@media (max-width:900px){.lp-hero{grid-template-columns:1fr;gap:2rem}.lp-pricing{grid-template-columns:1fr}}
@media (max-width:760px){.lp-h1{font-size:2rem}.lp-input-row{flex-direction:column}.lp-input-row input{flex:none}.lp-row{grid-template-columns:3.75rem minmax(0,1fr) 1rem;gap:.75rem;padding:.9rem 1rem}
.lp-ref{display:none}.lp-median,.lp-cta{grid-column:2;text-align:left}.lp-median strong,.lp-median span{display:inline;margin-right:.35rem}.lp-arrow{grid-column:3;grid-row:1/span 2}
.lp-section-head{display:block}.lp-steps,.lp-proof{grid-template-columns:1fr;gap:1.25rem}.lp-prices>div{padding-left:.75rem}
.top{flex-wrap:wrap}.top nav{gap:.25rem 1rem}}
@media (max-width:760px){.stats{grid-template-columns:1fr 1fr}.stat:nth-child(3){border-left:0}.proj{grid-template-columns:1fr}.tenders li{grid-template-columns:1fr}.wrap{padding:1rem 1rem 3rem}.top{padding:.6rem 1rem}}
`;

const dateOnly = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Singapore', day: 'numeric', month: 'short', year: 'numeric' });
const dateTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Singapore', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
export const day = (value) => (value ? dateOnly.format(new Date(value)) : '');
const when = (value) => (value ? `${dateTime.format(new Date(value))} SGT` : 'not yet');
const categoryNames = { 'cleaning-facilities': 'Cleaning and facilities', security: 'Security', 'ict-services': 'IT services', 'construction-renovation': 'Construction and renovation',
  'events-community': 'Events and community', 'training-consultancy': 'Training and consultancy', catering: 'Catering', other: 'Other professional services' };
const mark = '<span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg></span>';
const banner = (message, kind = 'bad') => (message ? `<p class="banner ${kind}" role="${kind === 'bad' ? 'alert' : 'status'}">${esc(message)}</p>` : '');
const hidden = (name, value) => `<input type="hidden" name="${esc(name)}" value="${esc(value ?? '')}">`;

export function layout({ title, csrf, company, body, signedIn, wide = false }) {
  const nav = signedIn && !company
    ? `<form method="post" action="/signout">${hidden('csrf', csrf)}<button class="link" type="submit">Sign out</button></form>`
    : company
    ? `<a href="/home">Home</a><a href="/">Open tenders</a><!--credits--><form method="post" action="/signout">${hidden('csrf', csrf)}<button class="link" type="submit">Sign out</button></form>`
    : '<a href="/sample">Sample brief</a><a href="/signin">Sign in</a><a class="btn primary" href="/signup">Create an account</a>';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Tender Desk</title><link rel="stylesheet" href="/app.css"></head><body>
<header class="top"><a class="brand" href="/">${mark}<span>Tender Desk</span></a><nav aria-label="Main">${company ? `<span class="muted small">${esc(company)}</span>` : ''}${nav}</nav></header>
<main class="wrap${wide ? ' wide' : ''}">${body}</main></body></html>`;
}

// Thin evidence (under ten awards, or a band wider than five times): the count and a rounded span, never quartiles.
export const thinLine = (n, cents) => `${plural(n, 'comparable award')}${cents.length ? `, ${roughSpread(cents)}` : ''}`;
const thinTile = (n, cents) => `<div class="stats"><div class="stat wide"><span class="big">${esc(thinLine(n, cents))}</span><span class="label">Too few or too varied for quartiles: treat these as a rough guide</span></div></div>`;

function tenderList(tenders, csrf, { matches } = {}) {
  if (!tenders.length) return '<p class="empty"><strong>No open tenders yet.</strong>GeBIZ lists new tenders each working day; this list grows as they are published.</p>';
  return `<ul class="tenders">${tenders.map((item) => {
    const tender = item.tender ?? item;
    const snap = item.check?.snapshot;
    const summary = !item.check ? (matches ? 'Run the free price check to see comparable awards' : '') : item.check.status !== 'ready' ? 'Too few comparable awards for a price range'
      : snap.thin ? `${thinLine(snap.n, (snap.comparables ?? []).map((c) => c.total_awarded_cents))} · a rough guide only`
        : `Middle half of past awards: ${wholeSgd(snap.price_band.low_cents)} to ${wholeSgd(snap.price_band.high_cents)} (median ${wholeSgd(snap.price_band.median_cents)}, ${plural(snap.n, 'award')})`;
    const fit = item.fit ? [item.fit.category_match ? 'In your categories' : null,
      item.fit.within_capacity === false ? 'Median is above your largest contract' : item.fit.within_capacity ? 'Within your capacity' : null,
      item.fit.related_projects ? `${plural(item.fit.related_projects, 'related verified project')}` : null].filter(Boolean).join(' · ') : '';
    return `<li><div><strong>${esc(displayTitle(tender.title))}</strong>
<span class="meta">${esc(tender.agency)} · <span class="num">${esc(tender.tender_no)}</span>${tender.closes_at ? ` · closes ${esc(day(tender.closes_at))}` : ''}${item.closesInDays !== undefined && item.closesInDays <= 3 ? ` <span class="chip warning">Closes in ${item.closesInDays} day${item.closesInDays === 1 ? '' : 's'}</span>` : ''}</span>
${summary ? `<span class="meta">${esc(summary)}</span>` : ''}${fit ? `<span class="meta">${esc(fit)}</span>` : ''}</div>
<div class="row-actions"><form method="post" action="/check">${hidden('csrf', csrf)}${hidden('tender_no', tender.tender_no)}<button type="submit">Free price check</button></form>
${!matches ? '' : item.taken ? '<span class="muted small">Not available for a reviewed brief right now.</span>' : item.ownRequest ? `<a class="btn outline" href="/requests/${esc(item.ownRequest)}">View your brief</a>`
    : item.check?.status === 'ready' ? `<a class="btn primary" href="/checkout?tender=${encodeURIComponent(tender.tender_no)}">Reviewed brief · 1 credit</a>` : ''}</div></li>`;
  }).join('')}</ul>`;
}

// GeBIZ titles arrive in capitals and wrapped in procurement boilerplate. For display only: the tender number and the
// full title stay unchanged everywhere they are stored or matched.
const keepUpper = new Set(['IT', 'ICT', 'AV', 'AI', 'IOT', 'CCTV', 'ACMV', 'M&E', 'MOH', 'MOE', 'MOM', 'MSF', 'MND', 'HDB', 'NEA', 'LTA', 'SAF', 'PUB',
  'URA', 'JTC', 'HPB', 'PA', 'NLB', 'NUS', 'NTU', 'SMU', 'SUTD', 'SIT', 'SUSS', 'ITE', 'CPF', 'IRAS', 'ICA', 'SPF', 'SCDF', 'MINDEF', 'GOVTECH', 'UAT', 'SLA', 'SIA']);
const keepProper = new Map(['singapore', 'jurong', 'taman', 'tampines', 'woodlands', 'changi', 'sentosa', 'punggol', 'sengkang', 'bedok', 'yishun', 'toa', 'payoh',
  'ang', 'mo', 'kio', 'bukit', 'timah', 'batok', 'panjang', 'merah', 'clementi', 'queenstown', 'pasir', 'ris', 'serangoon', 'hougang', 'geylang', 'kallang', 'marina',
  'tuas', 'seletar', 'novena', 'orchard', 'bishan', 'choa', 'chu', 'kang', 'lim', 'chu'].map((w) => [w, w[0].toUpperCase() + w.slice(1)]));
export function displayTitle(raw) {
  const original = String(raw ?? '').replace(/\s+/g, ' ').trim();
  let title = original.replace(/^[A-Z]{2,}[0-9/]*\s*[-–:]\s*/, '')
    .replace(/^(invitation to (quote|tender)|itq|itt|quotation|tender)\b\s*(for\s+)?(the\s+)?(provision\s+of\s+)?/i, '')
    .replace(/^(for\s+)?(the\s+)?provision\s+of\s+/i, '').replace(/^for\s+the\s+/i, '');
  if (title.length < 8) title = original;
  if (!/[a-z]/.test(title)) {
    title = title.toLowerCase().replace(/[a-z0-9&]+/g, (word) => (keepUpper.has(word.toUpperCase()) ? word.toUpperCase() : keepProper.get(word) ?? word));
  }
  return title.charAt(0).toUpperCase() + title.slice(1);
}
const tenderKind = (tenderNo) => (/ETQ/.test(tenderNo ?? '') ? 'ITQ' : /ETT/.test(tenderNo ?? '') ? 'ITT' : '');
const shortDay = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Singapore', day: 'numeric', month: 'short' });
const yearOf = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Singapore', year: 'numeric' });
const monthYear = (iso) => new Intl.DateTimeFormat('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`));
const arrow = '<svg class="lp-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14m-5-5 5 5-5 5"/></svg>';

function closingRow(row, csrf) {
  const closes = row.closes_at ? new Date(row.closes_at) : undefined;
  const kind = tenderKind(row.tender_no);
  const right = row.median_cents ? `<span class="lp-median num"><strong>${wholeSgd(row.median_cents)}</strong><span>median award</span></span>` : '<span class="lp-cta">Check price</span>';
  return `<li><form method="post" action="/check">${hidden('csrf', csrf)}${hidden('tender_no', row.tender_no)}<button class="lp-row" type="submit">
<span class="lp-close num">${closes ? `<strong>${esc(shortDay.format(closes))}</strong><span>${esc(yearOf.format(closes))} · closes</span>` : '<strong>Open</strong><span>no closing date</span>'}</span>
<span class="lp-body"><span class="lp-title">${esc(displayTitle(row.title))}</span><span class="lp-meta"><span>${esc(row.agency)}</span>${kind ? `<span class="lp-kind">${kind}</span>` : ''}<span class="lp-ref num">${esc(row.tender_no)}</span></span></span>
${right}${arrow}</button></form></li>`;
}

function exampleCard(example) {
  const snap = example?.check?.status === 'ready' && !example.check.snapshot.thin ? example.check.snapshot : undefined;
  if (!snap) return '';
  const band = snap.price_band;
  const values = (snap.comparables ?? []).map((c) => c.total_awarded_cents).filter((v) => v > 0);
  const lo = Math.log10(Math.min(...values, band.low_cents) * 0.85); const hi = Math.log10(Math.max(...values, band.high_cents) * 1.15);
  const x = (cents) => (8 + ((Math.log10(cents) - lo) / (hi - lo)) * 384).toFixed(1);
  const dots = values.map((v) => `<circle cx="${x(v)}" cy="7" r="3.5"/>`).join('');
  return `<section class="panel lp-example" aria-labelledby="example-heading"><header><h2 id="example-heading">What a free check shows</h2><span class="lp-tag">Example</span></header>
<div class="lp-example-body"><p class="lp-example-title">${esc(example.label)}</p>
<p class="lp-caption">Middle half of comparable awards</p><p class="lp-range num">${wholeSgd(band.low_cents)} to ${wholeSgd(band.high_cents)}</p>
<svg class="lp-band" viewBox="0 0 400 36" role="img" aria-label="Each dot is one past award; the shaded band is the middle half, the line is the median.">
<rect class="track" x="0" y="20" width="400" height="12" rx="4"/><rect class="mid" x="${x(band.low_cents)}" y="20" width="${(x(band.high_cents) - x(band.low_cents)).toFixed(1)}" height="12" rx="3"/>${dots}
<line class="med" x1="${x(band.median_cents)}" x2="${x(band.median_cents)}" y1="16" y2="36"/></svg>
<dl class="lp-facts num"><div><dt>Median award</dt><dd>${wholeSgd(band.median_cents)}</dd></div><div><dt>Comparable awards</dt><dd>${esc(plural(snap.n, 'award'))}</dd></div></dl></div>
<p class="lp-example-foot">Real GeBIZ awards matched on “${esc(example.check.query_used)}”. Your check runs on the tender you pick.</p></section>`;
}

const pasteFields = (csrf) => `<form class="form lp-paste-form" method="post" action="/check">${hidden('csrf', csrf)}
<label for="title">Tender title</label><input id="title" name="title" required maxlength="300">
<label for="agency">Agency <span class="hint">(optional)</span></label><input id="agency" name="agency" maxlength="250">
<label for="text">Description <span class="hint">(optional; the first 4000 characters are read)</span></label><textarea id="text" name="text" rows="4"></textarea>
<div><button class="primary" type="submit">Check prices</button></div></form>`;

const pasteForm = (csrf) => `<section class="panel"><header><h2>Paste a tender</h2></header>${pasteFields(csrf)}</section>`;

export function renderLanding({ tenders, refreshedAt, csrf, example, proof, prices, notice }) {
  const shown = tenders.slice(0, 6);
  const rest = tenders.slice(6);
  const list = !tenders.length
    ? '<p class="empty"><strong>No open tenders right now.</strong>GeBIZ lists new tenders each working day. Paste one above to check it.</p>'
    : `<ul class="lp-list">${shown.map((row) => closingRow(row, csrf)).join('')}</ul>
${rest.length ? `<details class="lp-more"><summary>Show ${plural(rest.length, 'more open tender')}</summary><ul class="lp-list">${rest.map((row) => closingRow(row, csrf)).join('')}</ul></details>` : ''}
<p class="lp-foot">ITQ is an invitation to quote (smaller, quicker buys); ITT is an invitation to tender (larger, formal ones).</p>`;
  const free = prices && prices.welcome >= prices.perBrief;
  const packs = (prices?.packs ?? []).map((pack) => `<div><dt>${esc(plural(pack.credits, 'brief'))}</dt><dd>${esc(wholeSgd(pack.cents))}</dd>${pack.credits > 1 ? `<small>${esc(wholeSgd(Math.round(pack.cents / pack.credits)))} a brief</small>` : '<small>one credit</small>'}</div>`).join('');
  return layout({ title: 'Know the prices before you bid', csrf, wide: true, body: `<section class="lp-hero">
<div><h1 class="lp-h1">Know the prices before you bid.</h1>
<p class="lp-intro">Is this GeBIZ tender worth your time? See what similar government contracts were actually awarded for.</p>
${banner(notice, 'bad')}
<form class="lp-check" method="post" action="/check">${hidden('csrf', csrf)}<label for="query">GeBIZ tender number or title</label>
<div class="lp-input-row"><input id="query" name="query" required maxlength="300" placeholder="e.g. HPB000ETT26000018, or office cleaning for a polyclinic"><button class="primary" type="submit">Check price</button></div>
<p class="lp-note">Free price check. No account needed.</p></form>
<details class="lp-paste"><summary>Paste the full tender text instead</summary>${pasteFields(csrf)}</details></div>
${exampleCard(example)}</section>
<section aria-labelledby="closing-heading"><div class="lp-section-head"><h2 id="closing-heading">Closing soon</h2><p>Tenders last updated ${esc(when(refreshedAt))}. Pick one for a free price check.</p></div>
<div class="panel">${list}</div></section>
<section class="lp-how" aria-labelledby="how-heading"><h2 id="how-heading">From a price check to a bid decision</h2>
<ol class="lp-steps"><li><h3>Check past award prices</h3><p>Pick a tender or paste its title. See what comparable contracts were awarded for, free.</p></li>
<li><h3>Get a reviewed brief</h3><p>Our AI drafts it and a person approves it, citing only your checked projects. Usually within one business day.</p></li>
<li><h3>Decide whether to bid</h3><p>A bid or no-bid recommendation and where to price, against the awards you saw.</p></li></ol>
<p class="lp-sample"><a href="/sample">Read a sample reviewed brief</a></p></section>
${packs ? `<section class="lp-pricing" aria-labelledby="pricing-heading"><div><h2 id="pricing-heading">${free ? 'Your first reviewed brief is free.' : 'Reviewed briefs'}</h2><p>${free ? 'One per company (UEN). After that, one brief costs one credit.' : 'One brief costs one credit.'}</p>
<p><a class="btn primary" href="/signup">Create an account</a></p></div><dl class="lp-prices num">${packs}</dl></section>` : ''}
${proof ? `<section class="lp-proof" aria-label="Data and backtest"><div><h2>Built on ${esc(proof.awards.toLocaleString('en-SG'))} GeBIZ awards</h2><p>Public award records from ${esc(proof.from)} to ${esc(proof.to)}, used to find comparable contracts. Not a quote: GeBIZ publishes winning amounts only.</p></div>
${proof.backtest ? `<div><h2>A tested middle-half range</h2><p>On ${esc(proof.backtest.n.toLocaleString('en-SG'))} contracts awarded in 2026 and held back from the data, ${proof.backtest.pct}% of actual awards fell inside the predicted middle half. A well-calibrated middle-half range should catch about 50%.</p></div>` : ''}</section>` : ''}` });
}

export const landingProof = (dataset, backtest) => {
  const dates = dataset.contracts.map((c) => c.last_award_date).filter(Boolean).sort();
  const scored = backtest ? [...backtest.predictions.values()] : [];
  const inBand = scored.filter((p) => p.actual_cents >= p.band.low_cents && p.actual_cents <= p.band.high_cents).length;
  return { awards: dataset.contracts.length, from: monthYear(dates[0]), to: monthYear(dates.at(-1)),
    backtest: scored.length >= 50 ? { n: scored.length, pct: Math.round((inBand / scored.length) * 100) } : undefined };
};

// Lower quartile, median, upper quartile: left to right, the same order as the chart.
const quartileTiles = (band, n, countLabel) => `<div class="stats"><div class="stat"><span class="big">${wholeSgd(band.low_cents)}</span><span class="label">Lower quartile: a quarter were below</span></div>
<div class="stat"><span class="big">${wholeSgd(band.median_cents)}</span><span class="label">Median award: half were above, half below</span></div>
<div class="stat"><span class="big">${wholeSgd(band.high_cents)}</span><span class="label">Upper quartile: a quarter were above</span></div>
<div class="stat"><span class="big">${n}</span><span class="label">${countLabel}</span></div></div>`;

export function renderCheck({ tender, reading, check, csrf, company, notice, refusal }) {
  const ready = check.status === 'ready';
  const snap = check.snapshot;
  const band = ready ? snap.price_band : undefined;
  const thin = Boolean(band && snap.thin);
  const allCents = (snap.comparables ?? []).map((c) => c.total_awarded_cents).filter((v) => v > 0);
  // The answer first: one sentence and the range, then the chart. Thin evidence gets the count and a rounded spread.
  const answer = !band
    ? `<div class="empty"><strong>Too few comparable awards for a price range.</strong>We need at least five past awards that match. Try broader or different search terms below.</div>`
    : `<div class="ck-answer"><p class="ck-lead">Similar government contracts went for</p>
${thin ? `<p class="ck-range ck-thin num">${esc(thinLine(snap.n, allCents))}</p>
<p class="banner">A rough guide only: ${snap.wide_band ? 'past awards for this kind of work vary a lot' : `only ${plural(snap.n, 'comparable award')}`}. A reviewed brief would advise on bidding and where to aim, but give no dollar range.</p>`
    : `<p class="ck-range num">${wholeSgd(band.low_cents)} to ${wholeSgd(band.high_cents)}</p>
<p class="ck-sub">The middle half of ${esc(plural(snap.n, 'comparable award'))}. Median award <strong class="num">${wholeSgd(band.median_cents)}</strong>: half were above, half below.</p>`}
${allCents.length ? `<div class="ck-chart">${priceChart({ awards: allCents.map((cents) => ({ cents })), band, thin })}</div>` : ''}
${snap.top_agencies?.length ? `<p class="ck-who">Bought by ${esc(snap.top_agencies.slice(0, 3).map((a) => a.name).join(', '))}${snap.top_agencies.length > 3 ? ' and others' : ''}.${snap.top_suppliers?.length ? ` The most frequent winner took ${esc(plural(snap.top_suppliers[0].wins, 'award'))} of ${snap.n}.` : ''}</p>` : ''}</div>`;
  const keep = tender.tender_no && !tender.pasted ? hidden('tender_no', tender.tender_no)
    : `${hidden('title', tender.title)}${hidden('agency', tender.agency)}${hidden('text', tender.text)}`;
  const termsValue = (reading.terms ?? []).join(', ');
  const category = snap.filters?.category ?? reading.category ?? '';
  const matched = check.query_used && ready ? `Matched on "${esc(check.query_used)}", the most specific of these terms with at least five past awards${snap.filters?.category ? ` (in ${esc(categoryNames[snap.filters.category] ?? snap.filters.category)})` : ''}. Awards under S$1,000 are left out: they are panel or nominal values, not prices.` : '';
  const refine = `<details class="ck-refine"${ready ? '' : ' open'}><summary>${ready && check.query_used ? `Compared with past awards for “${esc(check.query_used)}” · change the search terms` : 'Change the search terms'}</summary>
<form class="form" method="post" action="/check">${hidden('csrf', csrf)}${keep}
<label for="terms">Search terms</label><input id="terms" name="terms" value="${esc(termsValue)}" maxlength="120">
<span class="hint">Separate terms with commas. ${ready ? '' : 'No search terms found five past awards. Try broader or different terms. '}${matched}</span>
<div><button type="submit">Check again</button></div></form></details>`;
  const rows = check.comparables.map((c) => `<tr><td data-label="Tender" class="num nowrap">${esc(c.tender_no)}</td><td data-label="Description">${esc(c.description)}<span class="sub-line">${esc(c.agency)}</span></td>
<td data-label="Winner">${esc(c.suppliers.join(', '))}</td><td data-label="Awarded" class="r num nowrap">${wholeSgd(c.awarded_cents)}</td><td data-label="Date" class="num nowrap">${esc(day(c.award_date))}</td></tr>`).join('');
  const awards = rows ? `<details class="panel ck-awards"><summary>See the comparable awards${snap.n > check.comparables.length ? ` (latest ${check.comparables.length} of ${snap.n})` : ` (${check.comparables.length})`}</summary>
<div class="table-wrap"><table class="stack"><thead><tr><th>Tender</th><th>Description</th><th>Winner</th><th class="r">Awarded</th><th>Date</th></tr></thead><tbody>${rows}</tbody></table></div></details>` : '';
  const checkoutQuery = new URLSearchParams({ tender: tender.tender_no ?? '', terms: termsValue, category }).toString();
  const next = refusal ? banner(refusal, 'bad') : !band
    ? '<p class="small">A reviewed brief needs at least five comparable awards. Try other search terms first.</p>'
    : company
      ? (tender.tender_no && !tender.pasted ? `<a class="btn primary" href="/checkout?${esc(checkoutQuery)}">Ask for a reviewed brief · 1 credit</a>`
        : `<form method="post" action="/checkout/start">${hidden('csrf', csrf)}${keep}${hidden('terms', termsValue)}${hidden('category', category)}<button class="primary" type="submit">Ask for a reviewed brief · 1 credit</button></form>`)
      : '<a class="btn primary" href="/signup">Get your first brief free</a><p class="small muted">Create an account with your work email and company UEN.</p>';
  const meta = [tender.agency ? esc(tender.agency) : '', tender.tender_no && !tender.pasted ? `<span class="num">${esc(tender.tender_no)}</span>` : '',
    tender.closes_at ? `<span class="nowrap">closes ${esc(day(tender.closes_at))}</span>` : ''].filter(Boolean).join(' · ');
  return layout({ title: 'Price check', csrf, company, wide: true, body: `<div class="ck-head"><h1>${esc(displayTitle(tender.title))}</h1>${meta ? `<p class="sub">${meta}</p>` : ''}</div>
${banner(notice, 'ok')}
<div class="ck-grid"><div class="ck-main"><section class="panel ck-result" aria-label="Free price check">${answer}${refine}</section>${awards}
<p class="ck-limits">${esc(priceLimits)}</p></div>
<aside class="panel ck-offer" aria-labelledby="offer-heading"><h2 id="offer-heading">Should you bid, and at what price?</h2>
<p>A reviewed brief compares this tender with your checked projects and these awards, then says bid or no-bid and where to price. Our AI drafts it and a person approves it, usually within one business day.</p>
<div class="ck-next">${next}</div><p class="small"><a href="/sample">See a sample brief</a></p></aside></div>` });
}

export function renderSignup({ csrf, message }) {
  return layout({ title: 'Create an account', csrf, body: `<section class="panel narrow"><header><h2>Create an account</h2></header>
<form class="form" method="post" action="/signup">${hidden('csrf', csrf)}${banner(message)}
<label for="name">Your name</label><input id="name" name="name" autocomplete="name" maxlength="100" required>
<label for="email">Work email</label><input id="email" name="email" type="email" autocomplete="username" required>
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="new-password" minlength="8" required>
<span class="hint">At least 8 characters.</span>
<div><button class="primary" type="submit">Create account</button></div>
<p class="small">Already have an account? <a href="/signin">Sign in</a></p></form></section>` });
}

export function renderCheckEmail({ csrf, email }) {
  return layout({ title: 'Check your email', csrf, body: `<section class="panel narrow"><header><h2>Check your email</h2></header>
<div class="form"><p>We sent a link to <strong>${esc(email)}</strong>. Open it to confirm your email, then sign in to set up your company.</p>
<p class="small muted">No email after a few minutes? Check spam, or sign in and we will send a new link.</p>
<div><a class="btn primary" href="/signin">Go to sign in</a></div></div></section>` });
}

export function renderSignin({ csrf, message }) {
  return layout({ title: 'Sign in', csrf, body: `<section class="panel narrow"><header><h2>Sign in</h2></header>
<form class="form" method="post" action="/signin">${hidden('csrf', csrf)}${banner(message)}
<label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" required>
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required>
<div><button class="primary" type="submit">Sign in</button></div>
<p class="small">New here? <a href="/signup">Create an account</a></p></form></section>` });
}

export function renderProfile({ csrf, message, notice, noticeKind = 'ok', values = {}, existing, company, pasted = '' }) {
  const v = (name) => esc(values[name] ?? '');
  const chosen = new Set(values.categories ?? []);
  const rows = existing ? 3 : 6;
  const projects = Array.from({ length: rows }, (_, i) => `<div class="proj">
<input aria-label="Project ${i + 1} title" name="project_title_${i}" placeholder="Project title" maxlength="250" value="${v(`project_title_${i}`)}">
<input aria-label="Project ${i + 1} agency" name="project_agency_${i}" placeholder="Agency or client" maxlength="250" value="${v(`project_agency_${i}`)}">
<input aria-label="Project ${i + 1} value in S$" name="project_value_${i}" placeholder="Value S$" inputmode="decimal" value="${v(`project_value_${i}`)}">
<input aria-label="Project ${i + 1} GeBIZ tender number" name="project_gebiz_${i}" placeholder="GeBIZ tender no." maxlength="100" value="${v(`project_gebiz_${i}`)}"></div>`).join('');
  const listed = existing?.length ? `<ul class="feed">${existing.map((p) => `<li><div class="line"><strong>${esc(p.title)}</strong>${p.verified ? '<span class="chip done">✓ Checked</span>' : '<span class="chip warning">Not checked yet</span>'}</div></li>`).join('')}</ul>` : '';
  return layout({ title: 'Company profile', csrf, company, signedIn: true, body: `<div><h1>${existing ? 'Your company profile' : 'Tell us about your company'}</h1><p class="sub">${existing ? 'Changes apply to your next matches and briefs.' : 'You do this once. We use it to match tenders and to write your briefs.'}</p></div>
${existing ? `<section class="panel"><header><h2>Find my GeBIZ awards</h2></header><form class="form" method="post" action="/profile/assist">${hidden('csrf', csrf)}
<p>We look up government contracts awarded to <strong>${esc(values.name ?? '')}</strong> and add them below for you to check. Projects with a GeBIZ tender number are checked fastest, and only checked projects can be cited in a brief.</p>
<div><button type="submit">Find my GeBIZ awards</button></div></form></section>`
    : notice ? `<section class="panel"><details class="form"><summary>Fill the form again from text</summary><form class="form" method="post" action="/profile/assist">${hidden('csrf', csrf)}
<label for="aname">Company name, as registered</label><input id="aname" name="name" maxlength="150" required value="${v('name')}">
<label for="atext">Paste your capability statement, company profile or website "About" page <span class="hint">(optional)</span></label>
<textarea id="atext" name="text" rows="5" maxlength="6000">${esc(pasted)}</textarea>
<div><button type="submit">Fill in the form again</button></div></form></details></section>`
    : `<section class="panel"><header><h2>Fill this in for me</h2></header><form class="form" method="post" action="/profile/assist">${hidden('csrf', csrf)}
<label for="aname">Company name, as registered</label><input id="aname" name="name" maxlength="150" required value="${v('name')}">
<label for="atext">Paste your capability statement, company profile or website "About" page <span class="hint">(optional)</span></label>
<textarea id="atext" name="text" rows="5" maxlength="6000">${esc(pasted)}</textarea>
<span class="hint">Our AI reads it into the form below, and we look up GeBIZ awards under your company name. Nothing is saved until you check it and press Save.</span>
<div><button type="submit">Fill in the form</button></div></form></section>`}
<section class="panel"><form class="form" method="post" action="/profile">${hidden('csrf', csrf)}${banner(message)}${notice ? banner(notice, noticeKind) : ''}
<label for="cname">Company name</label><input id="cname" name="name" maxlength="150" required value="${v('name')}"${existing ? ' readonly' : ''}>
<label for="uen">UEN</label><input id="uen" name="uen" maxlength="10" autocapitalize="characters" ${existing ? 'readonly' : 'required'} value="${v('uen')}"><span class="hint">${existing ? 'To correct your UEN, contact Tender Desk.' : 'Your company\'s Unique Entity Number, as registered with ACRA. One account per company.'}</span>
<label for="capabilities">What your company does</label><textarea id="capabilities" name="capabilities" rows="3" maxlength="4000" required>${v('capabilities')}</textarea>
<fieldset><legend>Categories you bid in</legend><div class="cats">${tenderCategories.map((c) => `<label><input type="checkbox" name="categories" value="${c}"${chosen.has(c) ? ' checked' : ''}>${esc(categoryNames[c])}</label>`).join('')}</div></fieldset>
<label for="team">Team size</label><input id="team" name="team_size" inputmode="numeric" required value="${v('team_size')}"><span class="hint">People who would work on a contract, including subcontractors you use regularly.</span>
<label for="max">Largest single contract you could take on (S$)</label><input id="max" name="max_contract" inputmode="decimal" required value="${v('max_contract')}"><span class="hint">${values.largest_mentioned ? `Your text mentions a contract of S$${esc(values.largest_mentioned)}. ` : ''}We compare this with past award sizes to flag tenders that may be too big.</span>
<fieldset><legend>${existing ? 'Add past projects' : 'Past projects'}</legend><span class="hint">Private-sector projects count. For government work, add the GeBIZ tender number so we can check it against public award records; for private work we may ask for proof. Only checked projects can be cited in a brief.</span><span class="hint">After you save, we check each project against GeBIZ award records (a tender number makes this fastest) and mark it ✓ Checked here.</span>${listed}${projects}</fieldset>
<div><button class="primary" type="submit">Save profile</button></div></form></section>` });
}

const statusText = { requested: 'In review: usually within one business day', drafted: 'In review: usually within one business day', needs_info: 'Needs your reply', approved: 'Brief ready',
  declined: 'Declined', cancelled: 'Cancelled' };
const chipText = { requested: 'In review', drafted: 'In review', needs_info: 'Needs your reply', approved: 'Brief ready', declined: 'Declined', cancelled: 'Cancelled' };
const statusChip = { requested: 'progress', drafted: 'progress', needs_info: 'warning', approved: 'done', declined: 'danger', cancelled: '' };

export function renderHome({ context, matches, refreshedAt, csrf, flash }) {
  const { client, projects, requests } = context;
  const projectRows = projects.length ? `<ul class="feed">${projects.map((p) => `<li><div class="line"><strong>${esc(p.title)}</strong>
${p.verified ? '<span class="chip done">Checked</span>' : '<span class="chip warning">Unverified</span>'}</div>
<span class="meta">${esc([p.agency, p.value_cents !== null ? wholeSgd(p.value_cents) : null, p.gebiz_tender_no].filter(Boolean).join(' · '))}</span></li>`).join('')}</ul>
${projects.some((p) => !p.verified) ? '<p class="note">Unverified: we check these against GeBIZ before a brief can cite them.</p>' : ''}`
    : '<p class="empty">No past projects yet.</p>';
  const requestRows = requests.length ? `<ul class="feed">${requests.map((r) => `<li><div class="line"><a href="/requests/${esc(r.reference)}"><strong>${esc(r.title)}</strong></a>
<span class="chip ${statusChip[r.status]}">${esc(chipText[r.status])}</span></div><span class="meta">${esc(r.reference)} · ${esc(r.agency ?? '')}</span></li>`).join('')}</ul>`
    : '<p class="empty">No briefs yet. Ask for one on any open tender.</p>';
  return layout({ title: 'Home', csrf, company: client.name, body: `${banner(flash, 'ok')}<div><h1>Good ${greeting()}, ${esc(client.name)}</h1>
<p class="sub">Open tenders in your categories, with what similar contracts were awarded for.</p></div>
<div class="grid"><section class="panel"><header><h2>Open tenders for you</h2><span class="muted small">Updated ${esc(when(refreshedAt))}</span></header>${tenderList(matches, csrf, { matches: true })}</section>
<div class="stack-gap"><section class="panel"><header><h2>Your briefs</h2></header>${requestRows}</section>
<section class="panel"><header><h2>Your projects</h2><a class="small" href="/profile">Edit profile</a></header>${projectRows}</section>${pasteForm(csrf)}</div></div>` });
}
function greeting() {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Singapore', hour: '2-digit', hour12: false }).format(new Date()));
  return hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
}

export const creditWord = (n) => `${n} credit${Number(n) === 1 ? '' : 's'}`;

export function renderCheckout({ tender, company, csrf, refusal, terms, category, gaps = [], outside, notice, credits, requirements }) {
  const keep = tender.pasted ? `${hidden('title', tender.title)}${hidden('agency', tender.agency)}${hidden('text', tender.text)}` : hidden('tender_no', tender.tender_no);
  const perBrief = credits?.perBrief ?? 1;
  const short = credits && credits.balance < perBrief;
  return layout({ title: 'Checkout', csrf, company, body: `<div><p class="eyebrow">Reviewed brief</p><h1>${esc(tender.title)}</h1>
<p class="sub">${esc(tender.agency ?? '')}${tender.pasted ? '' : ` · <span class="num">${esc(tender.tender_no)}</span>`}</p></div>
${refusal ? banner(refusal) : `${banner(notice)}
${gaps.length ? `<section class="panel"><header><h2>Before you spend a credit</h2><span class="muted small">A brief is only as good as your profile</span></header><div class="form">
<ul class="bullets">${gaps.map((g) => `<li>${esc(g.message)}</li>`).join('')}</ul>
<div><a class="btn outline" href="/profile">Improve your profile</a> <span class="muted small">or go ahead below.</span></div></div></section>` : ''}
<section class="panel"><dl class="props"><div><dt>Brief</dt><dd>Bid or no-bid, a suggested price range when there are enough comparable awards, who usually wins, a requirements check and questions to ask</dd></div>
${tender.closes_at ? `<div><dt>Closes</dt><dd>${esc(day(tender.closes_at))}</dd></div>` : ''}<div><dt>For</dt><dd>${esc(company)}</dd></div><div><dt>Cost</dt><dd>Uses ${creditWord(perBrief)} · you have ${credits ? credits.balance : '?'}</dd></div>
<div><dt>When</dt><dd>Usually within one business day, after a person reviews it. If we decline it, the credit comes back.</dd></div>
<div><dt>Example</dt><dd><a href="/sample">See a sample brief</a></dd></div></dl>
${short ? `<div class="form"><p class="banner">You need ${creditWord(perBrief)} for a reviewed brief.</p><div><a class="btn primary" href="/credits">Buy credits</a></div></div>`
    : `<form class="form" method="post" action="/checkout">${hidden('csrf', csrf)}${keep}${hidden('terms', (terms ?? []).join(', '))}${hidden('category', category)}
<label for="requirements">Key requirements from the tender <span class="hint">(optional, up to 4000 characters: we check each one against your projects)</span></label>
<textarea id="requirements" name="requirements" rows="5" maxlength="4000">${esc(requirements ?? '')}</textarea>
${outside ? `<p class="banner">This tender is outside the categories in your profile. A brief may well say not to bid, and the credit is not returned for that.</p>
<label class="tick"><input type="checkbox" name="confirm_outside" value="yes" required> I understand and still want a brief on this tender</label>` : ''}
<div><button class="primary" type="submit">Use ${creditWord(perBrief)}</button></div></form>`}</section>`}
<p><a href="/home">Back to home</a></p>` });
}

const reasonText = { welcome: 'Welcome credit', purchase: 'Bought credits', brief: 'Reviewed brief', refund: 'Credit returned', adjustment: 'Adjustment' };
export function renderCredits({ company, csrf, credits, notice, noticeKind = 'bad' }) {
  const sgd = formatSgd;
  const list = credits.packs.find((p) => p.credits === 1)?.cents;
  const saving = (pack) => (list && pack.credits > 1 ? Math.round((1 - pack.cents / (pack.credits * list)) * 100) : 0);
  const packs = credits.packs.map((pack) => `<li><div><strong>${creditWord(pack.credits)}</strong><span class="meta">${pack.credits === 1 ? sgd(pack.cents)
    : `${sgd(pack.cents)} · ${sgd(Math.round(pack.cents / pack.credits))} a credit${saving(pack) > 0 ? ` · save ${saving(pack)}%` : ''}`}</span></div>
<div class="row-actions"><form method="post" action="/credits/buy">${hidden('csrf', csrf)}${hidden('credits', pack.credits)}<button class="primary" type="submit">Buy ${pack.credits}</button></form></div></li>`).join('');
  const history = credits.history.length ? `<ul class="feed">${credits.history.map((h) => `<li><div class="line"><strong>${esc(h.reason === 'purchase' ? `Bought ${creditWord(h.delta)}` : reasonText[h.reason] ?? h.reason)}</strong>
<span class="num ${h.delta > 0 ? 'plus' : 'minus'}">${h.delta > 0 ? '+' : ''}${h.delta}</span></div><span class="meta">${esc(day(h.created_at))}${h.reference ? ` · ${esc(h.reference)} · ${esc(h.title ?? '')}` : ''}</span></li>`).join('')}</ul>` : '<p class="empty">No credit activity yet.</p>';
  return layout({ title: 'Credits', csrf, company, body: `${banner(notice, noticeKind)}<div><h1>You have ${creditWord(credits.balance)}</h1>
<p class="sub">A reviewed brief uses ${creditWord(credits.perBrief)}. Credits don't expire, and a declined request gives its credit back.</p></div>
<p class="testmode" role="note">Test mode: no card is charged</p>
<div class="grid"><section class="panel"><header><h2>Buy credits</h2></header><ul class="tenders">${packs}</ul></section>
<section class="panel"><header><h2>History</h2></header>${history}</section></div>` });
}

const statusChipFor = { met: ['done', '✓ Met'], partly_met: ['warning', '◐ Partly met'], gap: ['danger', '✕ Gap'] };

// The paid brief as a visual report: verdict, the suggested range (computed by code) on a chart of the past awards,
// reasons, who usually wins, awards per year, the requirements scorecard, questions and risks, and the awards themselves.
function renderReport(request, awards) {
  const parts = request.parts;
  const band = request.price_band;
  const bid = parts.recommendation === 'bid';
  const range = parts.suggested_range ?? {};
  // Briefs drafted before the thin flag existed fall back to the same rule: under ten awards, or a wide band.
  const thin = parts.thin ?? (Number(parts.n) < 10 || Boolean(request.wide_band));
  const list = (items) => (items?.length ? `<ul class="bullets">${items.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>` : '<p class="empty">None.</p>');
  const counts = Object.fromEntries(['met', 'partly_met', 'gap'].map((k) => [k, (parts.requirements ?? []).filter((r) => r.status === k).length]));
  const requirements = parts.requirements?.length ? `<section class="panel"><header><h2>Requirements check</h2><span class="muted small">From the requirements you pasted</span></header>
<p class="scorecard"><span class="chip done">${counts.met} met</span><span class="chip warning">${counts.partly_met} partly met</span><span class="chip danger">${counts.gap} gap</span></p>
<ul class="reqs">${parts.requirements.map((r) => `<li><span><span class="chip ${statusChipFor[r.status][0]}">${statusChipFor[r.status][1]}</span></span><div>${esc(r.requirement)}<span class="evidence">${esc(r.evidence)}</span></div></li>`).join('')}</ul></section>` : '';
  const years = awards.map((a) => String(a.date ?? '').slice(0, 4)).filter((y) => /^\d{4}$/.test(y)).sort();
  const span = years.length ? (years[0] === years.at(-1) ? `These comparable awards date from ${years[0]}.` : `These comparable awards date from ${years[0]} to ${years.at(-1)}.`) : '';
  const panels = Number(parts.excluded_panels ?? 0);
  const panelNote = panels ? ` ${plural(panels, 'panel award')} (one award shared by several firms) ${panels === 1 ? 'was' : 'were'} left out: their totals are not the price of one contract.` : '';
  const trips = Number(parts.excluded_trips ?? 0);
  const tripNote = trips ? ` ${plural(trips, 'study trip')} that only name this kind of work in their title ${trips === 1 ? 'was' : 'were'} left out: they are travel packages, not this work.` : '';
  const awardRows = awards.map((a) => `<tr><td data-label="Tender" class="num nowrap">${esc(a.tender_no)}</td><td data-label="Description">${esc(a.description)}<span class="sub-line">${esc(a.agency)}</span></td>
<td data-label="Winner">${esc(a.winner)}</td><td data-label="Awarded" class="r num nowrap">${wholeSgd(a.cents)}</td><td data-label="Date" class="num nowrap">${esc(day(a.date))}</td></tr>`).join('');
  return `<div class="report">
<section class="panel"><div class="verdict ${bid ? 'bid' : 'nobid'}" role="note"><span class="label">Our recommendation</span><strong>${bid ? 'Bid' : 'Do not bid'}</strong></div>
${parts.suggested_range ? `<div class="callout"><span class="label">Suggested price range</span><span class="range">${esc(range.text ?? '')}</span><p>${esc(parts.price_position?.why ?? '')}</p></div>`
    : bid && parts.thin ? `<div class="callout"><span class="label">Where to price</span><p>${esc(thinText)}</p><p><strong>Roughly: ${esc(String(parts.position_text ?? '').toLowerCase())}.</strong> ${esc(parts.price_position?.why ?? '')}</p></div>` : ''}
${!bid ? '<header class="chart-head"><h2>Past awards, for context only</h2></header>' : parts.thin ? '<header class="chart-head"><h2>Past awards, a rough guide</h2></header>' : ''}
<div class="chart-wrap">${priceChart({ awards: awards.map((a) => ({ cents: a.cents, label: `${a.agency} · ${day(a.date)}` })), band, suggested: parts.suggested_range ?? undefined, thin })}</div>
${!band ? '' : thin ? thinTile(parts.n, awards.map((a) => a.cents)) : quartileTiles(band, parts.n, `Comparable awards${parts.query_used ? ` for "${esc(parts.query_used)}"` : ''}`)}</section>
<section class="panel"><header><h2>Why</h2></header>${list(parts.reasons)}</section>
<div class="report-row"><section class="panel"><header><h2>Who usually wins</h2><span class="muted small">Most frequent winners of these awards</span></header><div class="chart-wrap">${winnersChart(parts.winners, parts.n) || '<p class="empty">No repeat winners.</p>'}</div>${(parts.winners ?? []).slice(0, 5).reduce((sum, w) => sum + Number(w.wins), 0) > Number(parts.n) ? `<p class="limits">Some awards went to more than one firm, so these counts add up to more than ${esc(String(parts.n))}.</p>` : ''}</section>
<section class="panel"><header><h2>Awards per year</h2><span class="muted small">How steadily this work is bought</span></header><div class="chart-wrap">${yearsChart(awards.map((a) => ({ year: String(a.date ?? '').slice(0, 4) }))) || '<p class="empty">No dates.</p>'}</div></section></div>
${requirements}
<div class="report-row"><section class="panel"><header><h2>Questions to ask the agency</h2></header>${list(parts.questions)}</section>
<section class="panel"><header><h2>Risks</h2></header>${list(parts.risks)}</section></div>
<section class="panel"><header><h2>Your verified projects cited</h2></header>${list((parts.cited ?? []).map((p) => `${p.title}${p.agency ? ` (${p.agency})` : ''}`))}</section>
${awards.length ? `<section class="panel"><details class="awards"><summary>Show the ${awards.length} comparable awards</summary>
<div class="table-wrap"><table class="stack"><thead><tr><th>Tender</th><th>Description</th><th>Winner</th><th class="r">Awarded</th><th>Date</th></tr></thead><tbody>${awardRows}</tbody></table></div></details>
<p class="limits">${esc(span)}${esc(panelNote)}${esc(tripNote)} ${esc(priceLimits)} Contract scope and length differ between awards.</p></section>` : ''}
</div>`;
}

export function renderRequest({ request, company, csrf, justPaid, awards = [] }) {
  const band = request.price_band;
  const priceRow = !band ? '' : Number(request.n) < 10 || request.wide_band ? thinTile(request.n, awards.map((a) => a.cents))
    : quartileTiles(band, request.n ?? '', `Comparable awards${request.query_used ? ` for "${esc(request.query_used)}"` : ''}`);
  const bid = request.recommendation === 'bid';
  const body = request.status === 'approved' ? (request.parts ? renderReport(request, awards) : `<section class="panel"><div class="verdict ${bid ? 'bid' : 'nobid'}" role="note"><span class="label">Our recommendation</span><strong>${bid ? 'Bid' : 'Do not bid'}</strong></div>
${priceRow}<div class="brief">${renderBriefHtml(request.content, { skip: ['Recommendation', 'Comparable awards', 'Limits'] })}</div>
<p class="limits">${esc(priceLimits)} Contract scope and length differ between awards.</p></section>`)
    : request.status === 'declined' ? `<section class="panel"><header><h2>We could not advise on this tender</h2></header><div class="form"><p>${esc(request.decline_reason ?? '')}</p>
<p class="muted">Your credit has been returned.</p>
<div class="row-actions"><a class="btn outline" href="/">Browse open tenders</a></div></div></section>`
      : request.status === 'needs_info' ? `<section class="panel"><header><h2>We need a bit more before we can advise</h2></header><div class="form">
<p class="banner">${esc(request.info_request ?? '')}</p>
${request.info_due_at ? `<p><strong>Reply by ${esc(day(request.info_due_at))}.</strong> After that we close the request and return your credit, so the tender is free for others.</p>` : ''}
<p>Update your <a href="/profile">company profile</a> if that is what's missing, or add the tender's requirements below. Then resubmit: it costs no credit, and the tender stays yours meanwhile.</p>
<form class="form" method="post" action="/requests/${esc(request.reference)}/resubmit">${hidden('csrf', csrf)}
<label for="requirements">Key requirements from the tender <span class="hint">(optional, up to 4000 characters)</span></label>
<textarea id="requirements" name="requirements" rows="5" maxlength="4000">${esc(request.requirements_text ?? '')}</textarea>
<div><button class="primary" type="submit">Resubmit</button></div></form>
<form method="post" action="/requests/${esc(request.reference)}/cancel">${hidden('csrf', csrf)}<button class="outline" type="submit">Cancel and get your credit back</button></form></div></section>`
        : `<p class="banner">${esc(statusText[request.status])}. Your brief will appear on this page and on your home page.</p>
${request.status === 'requested' ? `<form method="post" action="/requests/${esc(request.reference)}/cancel">${hidden('csrf', csrf)}<button class="outline" type="submit">Cancel and get your credit back</button></form>` : ''}`;
  // An approved brief is finished: every step is done, none is current. The sample shows no steps at all.
  const stage = request.reference === 'SAMPLE' ? undefined : { requested: 1, drafted: 1, needs_info: 1, approved: 3 }[request.status];
  const steps = stage === undefined ? '' : `<ol class="steps">${['Requested', request.status === 'needs_info' ? 'Needs your reply' : 'In review', 'Brief ready'].map((label, at) =>
    `<li class="${at < stage ? 'done' : at === stage ? `current${request.status === 'needs_info' ? ' waiting' : ''}` : ''}"${at === stage ? ' aria-current="step"' : ''}>${label}</li>`).join('')}</ol>`;
  const paidBanner = justPaid ? `<p class="banner ok" role="status">Request received · 1 credit spent · ${esc(request.reference)} · ${esc(day(request.created_at))}</p>` : '';
  return layout({ title: request.reference, csrf, company, body: `<div><p class="eyebrow">${esc(request.reference)}</p><h1>${esc(request.title)}</h1>
<p class="sub">${esc(request.agency ?? '')}${request.source === 'feed' ? ` · <span class="num">${esc(request.tender_no)}</span>` : ''}${request.closes_at ? ` · <span class="nowrap">closes ${esc(day(request.closes_at))}</span>` : ''}</p></div>
${paidBanner}${steps}${body}<p><a href="/home">Back to home</a></p>` });
}

// A fictional sample brief, so a customer sees what a credit buys before spending one. Every figure is invented and labelled so.
const sampleAwards = [86000, 92500, 104000, 118000, 121500, 133000, 140000, 152000, 168000, 189000, 210000, 265000].map((dollars, i) => ({
  tender_no: `SAMPLE${String(i + 1).padStart(3, '0')}`, cents: dollars * 100, description: ['Community festival production', 'National Day celebrations at a community club',
    'School carnival and games', 'Heritage week events', 'Mid-Autumn lantern festival'][i % 5], agency: ['A town council', 'A community development council', 'A school', 'A heritage agency'][i % 4],
  date: `${2021 + (i % 5)}-0${(i % 9) + 1}-15`, winner: ['Example Events Pte Ltd', 'Sample Productions', 'Demo Stage Co'][i % 3] }));
export function renderSample({ csrf, company }) {
  const request = { status: 'approved', reference: 'SAMPLE', title: 'Event management for a community festival (sample)', agency: 'A town council', source: 'pasted',
    recommendation: 'bid', price_band: { low_cents: 11050000, median_cents: 13650000, high_cents: 17325000 }, n: sampleAwards.length, wide_band: false, query_used: 'event management',
    parts: { recommendation: 'bid', n: sampleAwards.length, query_used: 'event management',
      reasons: ['You have run community festivals for town councils before, which is exactly what this buyer is asking for.',
        'The scope sits comfortably inside the size of contract your team delivers.', 'This buyer issues this kind of work every year, so a good result builds a track record for later tenders.'],
      price_position: { band: 'lower_quartile_to_median', why: 'Your experience is strong but the scope is standard, so stay near the middle of past awards rather than at the top.' },
      suggested_range: { from_cents: 11050000, to_cents: 13650000, text: 'S$110,500 to S$136,500' },
      winners: [{ name: 'Example Events Pte Ltd', wins: 4 }, { name: 'Sample Productions', wins: 4 }, { name: 'Demo Stage Co', wins: 4 }],
      requirements: [{ requirement: 'Has delivered a public event for a government agency', status: 'met', evidence: 'Community festival for a town council' },
        { requirement: 'Holds public liability insurance', status: 'partly_met', evidence: 'Policy on file, but its cover may be below what the agency asks for' },
        { requirement: 'Has a certified crowd-control officer', status: 'gap', evidence: 'Not shown in your profile' }],
      questions: ['Can the event date move if the weather is bad?', 'Will the agency provide the venue permits, or is that the supplier\'s job?'],
      risks: ['Crowd-control certification may need a subcontractor, which adds cost.'], cited: [{ title: 'Community festival for a town council', agency: 'A town council' }] } };
  const page = renderRequest({ request, company, csrf, awards: sampleAwards });
  return page.replace('<main class="wrap">', '<main class="wrap"><p class="banner">Sample brief: a fictional example. The company, the awards and the figures are invented to show what a reviewed brief contains.</p>');
}
