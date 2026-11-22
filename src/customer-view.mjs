// HTML for the customer web app (the AI tender assistant). Server-rendered, no client JavaScript. Every link is written
// from the app root ("/home") and rewritten to the deployed base path by the handler.
import { formatSgd } from './brief-risk.mjs';
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
.proj{display:grid;grid-template-columns:2fr 1.5fr 1fr 1.2fr;gap:.5rem}
.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border-bottom:1px solid var(--line)}
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
@media (max-width:760px){.stats{grid-template-columns:1fr 1fr}.stat:nth-child(3){border-left:0}.proj{grid-template-columns:1fr}.tenders li{grid-template-columns:1fr}.wrap{padding:1rem 1rem 3rem}.top{padding:.6rem 1rem}}
`;

const dateOnly = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Singapore', day: 'numeric', month: 'short', year: 'numeric' });
const dateTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Singapore', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
export const day = (value) => (value ? dateOnly.format(new Date(value)) : '');
const when = (value) => (value ? `${dateTime.format(new Date(value))} SGT` : 'not yet');
const categoryNames = { 'cleaning-facilities': 'Cleaning and facilities', security: 'Security', 'ict-services': 'IT services', 'construction-renovation': 'Construction and renovation',
  'events-community': 'Events and community', 'training-consultancy': 'Training and consultancy', catering: 'Catering', other: 'Other professional services' };
const mark = '<span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg></span>';
const banner = (message, kind = 'bad') => (message ? `<p class="banner ${kind}" role="${kind === 'ok' ? 'status' : 'alert'}">${esc(message)}</p>` : '');
const hidden = (name, value) => `<input type="hidden" name="${esc(name)}" value="${esc(value ?? '')}">`;

export function layout({ title, csrf, company, body, signedIn }) {
  const nav = signedIn && !company
    ? `<form method="post" action="/signout">${hidden('csrf', csrf)}<button class="link" type="submit">Sign out</button></form>`
    : company
    ? `<a href="/home">Home</a><a href="/">Open tenders</a><!--credits--><form method="post" action="/signout">${hidden('csrf', csrf)}<button class="link" type="submit">Sign out</button></form>`
    : '<a href="/">Open tenders</a><a href="/signin">Sign in</a><a class="btn primary" href="/signup">Create an account</a>';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Tender Desk</title><link rel="stylesheet" href="/app.css"></head><body>
<header class="top"><a class="brand" href="/">${mark}<span>Tender Desk</span></a><nav aria-label="Main">${company ? `<span class="muted small">${esc(company)}</span>` : ''}${nav}</nav></header>
<main class="wrap">${body}</main></body></html>`;
}

function tenderList(tenders, csrf, { matches } = {}) {
  if (!tenders.length) return '<p class="empty"><strong>No open tenders yet.</strong>GeBIZ lists new tenders each working day; this list grows as they are published.</p>';
  return `<ul class="tenders">${tenders.map((item) => {
    const tender = item.tender ?? item;
    const summary = item.check ? (item.check.status === 'ready'
      ? `Similar contracts were awarded ${formatSgd(item.check.snapshot.price_band.low_cents)} to ${formatSgd(item.check.snapshot.price_band.high_cents)} (median ${formatSgd(item.check.snapshot.price_band.median_cents)}, ${plural(item.check.snapshot.n, 'award')})`
      : 'Too few comparable awards for a price range') + (item.check.snapshot?.wide_band ? ' · wide range, a rough guide only' : '') : '';
    const fit = item.fit ? [item.fit.category_match ? 'In your categories' : null,
      item.fit.within_capacity === false ? 'Median is above your largest contract' : item.fit.within_capacity ? 'Within your capacity' : null,
      item.fit.related_projects ? `${plural(item.fit.related_projects, 'related verified project')}` : null].filter(Boolean).join(' · ') : '';
    return `<li><div><strong>${esc(tender.title)}</strong>
<span class="meta">${esc(tender.agency)} · <span class="num">${esc(tender.tender_no)}</span>${tender.closes_at ? ` · closes ${esc(day(tender.closes_at))}` : ''}${item.closesInDays !== undefined && item.closesInDays <= 3 ? ` <span class="chip warning">Closes in ${item.closesInDays} day${item.closesInDays === 1 ? '' : 's'}</span>` : ''}</span>
${summary ? `<span class="meta">${esc(summary)}</span>` : ''}${fit ? `<span class="meta">${esc(fit)}</span>` : ''}</div>
<div class="row-actions"><form method="post" action="/check">${hidden('csrf', csrf)}${hidden('tender_no', tender.tender_no)}<button type="submit">Free price check</button></form>
${!matches ? '' : item.taken ? '<span class="muted small">Not available for a reviewed brief right now.</span>' : item.ownRequest ? `<a class="btn outline" href="/requests/${esc(item.ownRequest)}">View your brief</a>`
    : item.check?.status === 'ready' ? `<a class="btn primary" href="/checkout?tender=${encodeURIComponent(tender.tender_no)}">Reviewed brief · 1 credit</a>` : ''}</div></li>`;
  }).join('')}</ul>`;
}

const pasteForm = (csrf) => `<section class="panel"><header><h2>Paste a tender</h2></header>
<form class="form" method="post" action="/check">${hidden('csrf', csrf)}
<label for="title">Tender title</label><input id="title" name="title" required maxlength="300">
<label for="agency">Agency <span class="hint">(optional)</span></label><input id="agency" name="agency" maxlength="250">
<label for="text">Description <span class="hint">(optional; the first 4000 characters are read)</span></label><textarea id="text" name="text" rows="4"></textarea>
<div><button class="primary" type="submit">Check prices</button></div></form></section>`;

export function renderLanding({ tenders, refreshedAt, csrf }) {
  return layout({ title: 'Open tenders', csrf, body: `<section class="hero"><h1>Is this tender worth bidding on, and at what price?</h1>
<p>Pick an open GeBIZ tender, or paste one, and see what comparable government contracts were actually awarded for. Free, no account needed.</p>
<p class="small"><a href="/sample">See a sample reviewed brief</a> · An ITQ is an invitation to quote (smaller, quicker buys); an ITT is an invitation to tender (larger, formal ones).</p></section>
<div class="grid"><section class="panel"><header><h2>Open GeBIZ tenders</h2><span class="muted small">Tenders last updated ${esc(when(refreshedAt))}</span></header>
${tenderList(tenders, csrf)}</section>${pasteForm(csrf)}</div>` });
}

export function renderCheck({ tender, reading, check, csrf, company, notice, refusal }) {
  const band = check.status === 'ready' ? check.snapshot.price_band : undefined;
  const stats = band ? `<div class="stats"><div class="stat"><span class="big">${formatSgd(band.median_cents)}</span><span class="label">Median award: half were above, half below</span></div>
<div class="stat"><span class="big">${formatSgd(band.low_cents)}</span><span class="label">Lower quartile: a quarter were below</span></div>
<div class="stat"><span class="big">${formatSgd(band.high_cents)}</span><span class="label">Upper quartile: a quarter were above</span></div>
<div class="stat"><span class="big">${check.snapshot.n}</span><span class="label">Comparable awards: past contracts for similar work</span></div></div>
${check.snapshot.wide_band ? '<p class="banner inset-banner">Wide range: past awards for this kind of work vary a lot, so treat it as a rough guide.</p>' : ''}`
    : `<p class="empty"><strong>Too few comparable awards for a price range.</strong>We need at least five past awards that match. Try broader or different search terms.</p>`;
  const agencies = band && check.snapshot.top_agencies?.length ? `<p class="muted small inset">Buyers of this work: ${esc(check.snapshot.top_agencies.slice(0, 4).map((a) => a.name).join(', '))}.
${check.snapshot.top_suppliers?.length ? ` The most frequent winner took ${esc(plural(check.snapshot.top_suppliers[0].wins, 'award'))} of ${check.snapshot.n}.` : ''}</p>` : '';
  const rows = check.comparables.map((c) => `<tr><td data-label="Tender" class="num">${esc(c.tender_no)}</td><td data-label="Description">${esc(c.description)}<span class="sub-line">${esc(c.agency)}</span></td>
<td data-label="Winner">${esc(c.suppliers.join(', '))}</td><td data-label="Awarded" class="r num">${formatSgd(c.awarded_cents)}</td><td data-label="Date" class="num">${esc(day(c.award_date))}</td></tr>`).join('');
  const keep = tender.tender_no && !tender.pasted ? hidden('tender_no', tender.tender_no)
    : `${hidden('title', tender.title)}${hidden('agency', tender.agency)}${hidden('text', tender.text)}`;
  const termsValue = (reading.terms ?? []).join(', ');
  const category = check.snapshot.filters?.category ?? reading.category ?? '';
  const checkoutQuery = new URLSearchParams({ tender: tender.tender_no ?? '', terms: termsValue, category }).toString();
  const next = refusal ? banner(refusal, 'bad') : !band
    ? '<p>A reviewed brief needs at least five comparable awards. Try other search terms above first.</p>'
    : company
      ? (tender.tender_no && !tender.pasted ? `<a class="btn primary" href="/checkout?${esc(checkoutQuery)}">Ask for a reviewed brief · 1 credit</a>`
        : `<form method="post" action="/checkout/start">${hidden('csrf', csrf)}${keep}${hidden('terms', termsValue)}${hidden('category', category)}<button class="primary" type="submit">Ask for a reviewed brief · 1 credit</button></form>`)
      : '<a class="btn primary" href="/signup">Create an account: your first reviewed brief is free</a>';
  return layout({ title: 'Price check', csrf, company, body: `<div><p class="eyebrow">Free price check</p><h1>${esc(tender.title)}</h1>
<p class="sub">${esc(tender.agency ?? '')}${tender.tender_no && !tender.pasted ? ` · <span class="num">${esc(tender.tender_no)}</span>` : ''}${tender.closes_at ? ` · closes ${esc(day(tender.closes_at))}` : ''}</p></div>
${banner(notice, 'ok')}
<section class="panel"><header><h2>What comparable contracts were awarded for</h2></header>${stats}${agencies}
<form class="form" method="post" action="/check">${hidden('csrf', csrf)}${keep}
<label for="terms">Search terms</label><input id="terms" name="terms" value="${esc(termsValue)}" maxlength="120">
<span class="hint">Separate terms with commas. ${check.query_used ? `Matched on "${esc(check.query_used)}", the most specific of these terms with at least five past awards${check.snapshot.filters?.category ? ` (in ${esc(categoryNames[check.snapshot.filters.category] ?? check.snapshot.filters.category)})` : ''}. Awards under S$1,000 are left out: they are panel or nominal values, not prices.` : ''}</span>
<div><button type="submit">Check again</button></div></form>
${rows ? `<div class="table-wrap"><table class="stack"><thead><tr><th>Tender</th><th>Description</th><th>Winner</th><th class="r">Awarded</th><th>Date</th></tr></thead><tbody>${rows}</tbody></table></div>` : ''}
<p class="limits">${esc(priceLimits)}</p></section>
<section class="panel"><header><h2>Want advice on this tender?</h2></header><div class="form"><p>A reviewed brief tells you whether to bid and where to price against these awards, citing only your checked projects. Our AI drafts it and a person approves it, usually within one business day.</p><div>${next}</div></div></section>` });
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

export function renderSignin({ csrf, message }) {
  return layout({ title: 'Sign in', csrf, body: `<section class="panel narrow"><header><h2>Sign in</h2></header>
<form class="form" method="post" action="/signin">${hidden('csrf', csrf)}${banner(message)}
<label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" required>
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required>
<div><button class="primary" type="submit">Sign in</button></div>
<p class="small">New here? <a href="/signup">Create an account</a></p></form></section>` });
}

export function renderProfile({ csrf, message, values = {}, existing, company }) {
  const v = (name) => esc(values[name] ?? '');
  const chosen = new Set(values.categories ?? []);
  const rows = existing ? 3 : 6;
  const projects = Array.from({ length: rows }, (_, i) => `<div class="proj">
<input aria-label="Project ${i + 1} title" name="project_title_${i}" placeholder="Project title" maxlength="250" value="${v(`project_title_${i}`)}">
<input aria-label="Project ${i + 1} agency" name="project_agency_${i}" placeholder="Agency or client" maxlength="250" value="${v(`project_agency_${i}`)}">
<input aria-label="Project ${i + 1} value in S$" name="project_value_${i}" placeholder="Value S$" inputmode="decimal" value="${v(`project_value_${i}`)}">
<input aria-label="Project ${i + 1} GeBIZ tender number" name="project_gebiz_${i}" placeholder="GeBIZ tender no." maxlength="100" value="${v(`project_gebiz_${i}`)}"></div>`).join('');
  const listed = existing?.length ? `<ul class="feed">${existing.map((p) => `<li><div class="line"><strong>${esc(p.title)}</strong>${p.verified ? '<span class="chip done">Checked</span>' : '<span class="chip warning">Unverified</span>'}</div></li>`).join('')}</ul>` : '';
  return layout({ title: 'Company profile', csrf, company, signedIn: true, body: `<div><h1>${existing ? 'Your company profile' : 'Tell us about your company'}</h1><p class="sub">${existing ? 'Changes apply to your next matches and briefs.' : 'You do this once. We use it to match tenders and to write your briefs.'}</p></div>
<section class="panel"><form class="form" method="post" action="/profile">${hidden('csrf', csrf)}${banner(message)}
<label for="cname">Company name</label><input id="cname" name="name" maxlength="150" required value="${v('name')}"${existing ? ' readonly' : ''}>
<label for="capabilities">What your company does</label><textarea id="capabilities" name="capabilities" rows="3" maxlength="4000" required>${v('capabilities')}</textarea>
<fieldset><legend>Categories you bid in</legend><div class="cats">${tenderCategories.map((c) => `<label><input type="checkbox" name="categories" value="${c}"${chosen.has(c) ? ' checked' : ''}>${esc(categoryNames[c])}</label>`).join('')}</div></fieldset>
<label for="team">Team size</label><input id="team" name="team_size" inputmode="numeric" required value="${v('team_size')}"><span class="hint">People who would work on a contract, including subcontractors you use regularly.</span>
<label for="max">Largest contract you could deliver (S$)</label><input id="max" name="max_contract" inputmode="decimal" required value="${v('max_contract')}"><span class="hint">We compare this with past award sizes to flag tenders that may be too big.</span>
<fieldset><legend>${existing ? 'Add past projects' : 'Past projects'}</legend><span class="hint">Private-sector projects count. For government work, add the GeBIZ tender number so we can check it against public award records; for private work we may ask for proof. Only checked projects can be cited in a brief.</span>${listed}${projects}</fieldset>
<div><button class="primary" type="submit">Save profile</button></div></form></section>` });
}

const statusText = { requested: 'In review: usually within one business day', drafted: 'In review: usually within one business day', approved: 'Brief ready',
  declined: 'Declined', cancelled: 'Cancelled' };
const chipText = { requested: 'In review', drafted: 'In review', approved: 'Brief ready', declined: 'Declined', cancelled: 'Cancelled' };
const statusChip = { requested: 'progress', drafted: 'progress', approved: 'done', declined: 'danger', cancelled: '' };

export function renderHome({ context, matches, refreshedAt, csrf, flash }) {
  const { client, projects, requests } = context;
  const projectRows = projects.length ? `<ul class="feed">${projects.map((p) => `<li><div class="line"><strong>${esc(p.title)}</strong>
${p.verified ? '<span class="chip done">Checked</span>' : '<span class="chip warning">Unverified</span>'}</div>
<span class="meta">${esc([p.agency, p.value_cents !== null ? formatSgd(p.value_cents) : null, p.gebiz_tender_no].filter(Boolean).join(' · '))}</span></li>`).join('')}</ul>
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

export function renderCheckout({ tender, company, csrf, refusal, terms, category, noChecked, outside, notice, credits, requirements }) {
  const keep = tender.pasted ? `${hidden('title', tender.title)}${hidden('agency', tender.agency)}${hidden('text', tender.text)}` : hidden('tender_no', tender.tender_no);
  const perBrief = credits?.perBrief ?? 1;
  const short = credits && credits.balance < perBrief;
  return layout({ title: 'Checkout', csrf, company, body: `<div><p class="eyebrow">Reviewed brief</p><h1>${esc(tender.title)}</h1>
<p class="sub">${esc(tender.agency ?? '')}${tender.pasted ? '' : ` · <span class="num">${esc(tender.tender_no)}</span>`}</p></div>
${refusal ? banner(refusal) : `${banner(notice)}
${noChecked ? '<p class="banner">None of your projects has been checked yet, so this brief cannot cite your track record. You can go ahead now, or wait until we have checked your projects against GeBIZ.</p>' : ''}
<section class="panel"><dl class="props"><div><dt>Brief</dt><dd>Bid or no-bid, a suggested price range, who usually wins, a requirements check and questions to ask</dd></div>
<div><dt>For</dt><dd>${esc(company)}</dd></div><div><dt>Cost</dt><dd>Uses ${creditWord(perBrief)} · you have ${credits ? credits.balance : '?'}</dd></div>
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
export function renderCredits({ company, csrf, credits, notice }) {
  const sgd = (cents) => `S$${(cents / 100).toFixed(2)}`;
  const packs = credits.packs.map((pack) => `<li><div><strong>${creditWord(pack.credits)}</strong><span class="meta">${sgd(pack.cents)} · ${sgd(Math.round(pack.cents / pack.credits))} a credit</span></div>
<div class="row-actions"><form method="post" action="/credits/buy">${hidden('csrf', csrf)}${hidden('credits', pack.credits)}<button class="primary" type="submit">Buy ${pack.credits}</button></form></div></li>`).join('');
  const history = credits.history.length ? `<ul class="feed">${credits.history.map((h) => `<li><div class="line"><strong>${esc(h.reason === 'purchase' ? `Bought ${creditWord(h.delta)}` : reasonText[h.reason] ?? h.reason)}</strong>
<span class="num ${h.delta > 0 ? 'plus' : 'minus'}">${h.delta > 0 ? '+' : ''}${h.delta}</span></div><span class="meta">${esc(day(h.created_at))}${h.reference ? ` · ${esc(h.reference)} · ${esc(h.title ?? '')}` : ''}</span></li>`).join('')}</ul>` : '<p class="empty">No credit activity yet.</p>';
  return layout({ title: 'Credits', csrf, company, body: `${banner(notice, 'ok')}<div><h1>You have ${creditWord(credits.balance)}</h1>
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
  const list = (items) => (items?.length ? `<ul class="bullets">${items.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>` : '<p class="empty">None.</p>');
  const counts = Object.fromEntries(['met', 'partly_met', 'gap'].map((k) => [k, (parts.requirements ?? []).filter((r) => r.status === k).length]));
  const requirements = parts.requirements?.length ? `<section class="panel"><header><h2>Requirements check</h2><span class="muted small">From the requirements you pasted</span></header>
<p class="scorecard"><span class="chip done">${counts.met} met</span><span class="chip warning">${counts.partly_met} partly met</span><span class="chip danger">${counts.gap} gap</span></p>
<ul class="reqs">${parts.requirements.map((r) => `<li><span><span class="chip ${statusChipFor[r.status][0]}">${statusChipFor[r.status][1]}</span></span><div>${esc(r.requirement)}<span class="evidence">${esc(r.evidence)}</span></div></li>`).join('')}</ul></section>` : '';
  const awardRows = awards.map((a) => `<tr><td data-label="Tender" class="num nowrap">${esc(a.tender_no)}</td><td data-label="Description">${esc(a.description)}<span class="sub-line">${esc(a.agency)}</span></td>
<td data-label="Winner">${esc(a.winner)}</td><td data-label="Awarded" class="r num nowrap">${formatSgd(a.cents)}</td><td data-label="Date" class="num nowrap">${esc(day(a.date))}</td></tr>`).join('');
  return `<div class="report">
<section class="panel"><div class="verdict ${bid ? 'bid' : 'nobid'}" role="note"><span class="label">Our recommendation</span><strong>${bid ? 'Bid' : 'Do not bid'}</strong></div>
<div class="callout"><span class="label">Suggested price range</span><span class="range">${esc(range.text ?? '')}</span><p>${esc(parts.price_position?.why ?? '')}</p></div>
<div class="chart-wrap">${priceChart({ awards: awards.map((a) => ({ cents: a.cents, label: `${a.agency} · ${day(a.date)}` })), band, suggested: range })}</div>
${band ? `<div class="stats"><div class="stat"><span class="big">${formatSgd(band.median_cents)}</span><span class="label">Median award: half were above, half below</span></div>
<div class="stat"><span class="big">${formatSgd(band.low_cents)}</span><span class="label">Lower quartile: a quarter were below</span></div>
<div class="stat"><span class="big">${formatSgd(band.high_cents)}</span><span class="label">Upper quartile: a quarter were above</span></div>
<div class="stat"><span class="big">${parts.n}</span><span class="label">Comparable awards${parts.query_used ? ` for "${esc(parts.query_used)}"` : ''}</span></div></div>` : ''}
${request.wide_band ? '<p class="banner inset-banner">Wide range: past awards for this kind of work vary a lot, so treat it as a rough guide.</p>' : ''}</section>
<section class="panel"><header><h2>Why</h2></header>${list(parts.reasons)}</section>
<div class="report-row"><section class="panel"><header><h2>Who usually wins</h2><span class="muted small">Most frequent winners of these awards</span></header><div class="chart-wrap">${winnersChart(parts.winners, parts.n) || '<p class="empty">No repeat winners.</p>'}</div></section>
<section class="panel"><header><h2>Awards per year</h2><span class="muted small">How steadily this work is bought</span></header><div class="chart-wrap">${yearsChart(awards.map((a) => ({ year: String(a.date ?? '').slice(0, 4) }))) || '<p class="empty">No dates.</p>'}</div></section></div>
${requirements}
<div class="report-row"><section class="panel"><header><h2>Questions to ask the agency</h2></header>${list(parts.questions)}</section>
<section class="panel"><header><h2>Risks</h2></header>${list(parts.risks)}</section></div>
<section class="panel"><header><h2>Your verified projects cited</h2></header>${list((parts.cited ?? []).map((p) => `${p.title}${p.agency ? ` (${p.agency})` : ''}`))}</section>
${awards.length ? `<section class="panel"><details class="awards"><summary>Show the ${awards.length} comparable awards</summary>
<div class="table-wrap"><table class="stack"><thead><tr><th>Tender</th><th>Description</th><th>Winner</th><th class="r">Awarded</th><th>Date</th></tr></thead><tbody>${awardRows}</tbody></table></div></details>
<p class="limits">${esc(priceLimits)} Contract scope and length differ between awards.</p></section>` : ''}
</div>`;
}

export function renderRequest({ request, company, csrf, justPaid, awards = [] }) {
  const band = request.price_band;
  const priceRow = band ? `<div class="stats"><div class="stat"><span class="big">${formatSgd(band.median_cents)}</span><span class="label">Median award</span></div>
<div class="stat"><span class="big">${formatSgd(band.low_cents)}</span><span class="label">Lower quartile</span></div>
<div class="stat"><span class="big">${formatSgd(band.high_cents)}</span><span class="label">Upper quartile</span></div>
<div class="stat"><span class="big">${request.n ?? ''}</span><span class="label">Comparable awards${request.query_used ? ` for "${esc(request.query_used)}"` : ''}</span></div></div>
${request.wide_band ? '<p class="banner inset-banner">Wide range: past awards for this kind of work vary a lot, so treat it as a rough guide.</p>' : ''}` : '';
  const bid = request.recommendation === 'bid';
  const body = request.status === 'approved' ? (request.parts ? renderReport(request, awards) : `<section class="panel"><div class="verdict ${bid ? 'bid' : 'nobid'}" role="note"><span class="label">Our recommendation</span><strong>${bid ? 'Bid' : 'Do not bid'}</strong></div>
${priceRow}<div class="brief">${renderBriefHtml(request.content, { skip: ['Recommendation', 'Comparable awards', 'Limits'] })}</div>
<p class="limits">${esc(priceLimits)} Contract scope and length differ between awards.</p></section>`)
    : request.status === 'declined' ? `<section class="panel"><header><h2>We could not advise on this tender</h2></header><p class="form">${esc(request.decline_reason ?? '')}</p></section>`
      : `<p class="banner">${esc(statusText[request.status])}. Your brief will appear on this page and on your home page.</p>`;
  const stage = { requested: 1, drafted: 1, approved: 2 }[request.status];
  const steps = stage === undefined ? '' : `<ol class="steps">${['Paid', 'In review', 'Brief ready'].map((label, at) =>
    `<li class="${at < stage ? 'done' : at === stage ? 'current' : ''}"${at === stage ? ' aria-current="step"' : ''}>${label}</li>`).join('')}</ol>`;
  const paidBanner = justPaid ? `<p class="banner ok" role="status">Request received · 1 credit spent · ${esc(request.reference)} · ${esc(day(request.created_at))}</p>` : '';
  return layout({ title: request.reference, csrf, company, body: `<div><p class="eyebrow">${esc(request.reference)}</p><h1>${esc(request.title)}</h1>
<p class="sub">${esc(request.agency ?? '')}${request.source === 'feed' ? ` · <span class="num">${esc(request.tender_no)}</span>` : ''}${request.closes_at ? ` · closes ${esc(day(request.closes_at))}` : ''}</p></div>
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
