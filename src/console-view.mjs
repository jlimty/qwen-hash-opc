const escapes = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => escapes[char]);
export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const clock = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const dateOnly = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Singapore', day: 'numeric', month: 'short', year: 'numeric' });

import { isAdminActor, recordCode, recordHref, recordLink, riskChip } from './console-records.mjs';

export function money(cents) {
  const total = Number(cents);
  return `S$${Math.floor(total / 100).toLocaleString('en-US')}.${String(total % 100).padStart(2, '0')}`;
}

export function ago(ts) {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(ts).getTime()) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${plural(minutes, 'minute')} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${plural(hours, 'hour')} ago`;
  return dateOnly.format(new Date(ts));
}
export const stamp = (ts) => `<time class="num" datetime="${new Date(ts).toISOString()}" title="${clock.format(new Date(ts))} SGT">${clock.format(new Date(ts))}</time>`;

const icons = {
  overview: '<path d="M4 4.5h6v6H4zM14 4.5h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z"/>',
  briefs: '<path d="M14.5 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7.5z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 16.5h6"/>',
  conflicts: '<path d="M10.3 4.5 2 19a1.8 1.8 0 0 0 1.6 2.7h16.8A1.8 1.8 0 0 0 22 19L13.7 4.5a2 2 0 0 0-3.4 0z"/><path d="M12 10v4.5"/><path d="M12 17.8h.01"/>',
  clients: '<circle cx="9" cy="8" r="3.5"/><path d="M2.7 20a6.3 6.3 0 0 1 12.6 0"/><path d="M16 4.8a3.5 3.5 0 0 1 0 6.4"/><path d="M17.8 14.6a6.3 6.3 0 0 1 3.5 5.4"/>',
  backtest: '<path d="M3.5 21h17"/><path d="M7.5 17v-4"/><path d="M12 17V9"/><path d="M16.5 17V5"/>',
  audit: '<path d="M8.5 6h12"/><path d="M8.5 12h12"/><path d="M8.5 18h12"/><path d="M4 6h.01"/><path d="M4 12h.01"/><path d="M4 18h.01"/>',
  requests: '<path d="M4 6.5h16v11H4z"/><path d="M4 10h16"/><path d="M7.5 14h4"/>',
  check: '<circle cx="12" cy="12" r="8.5"/><path d="m8.5 12 2.4 2.4 4.6-5"/>',
  cross: '<circle cx="12" cy="12" r="8.5"/><path d="m9.2 9.2 5.6 5.6"/><path d="m14.8 9.2-5.6 5.6"/>',
  alert: '<path d="M12 4 2.8 19.5h18.4z"/><path d="M12 10v4"/><path d="M12 17.2h.01"/>',
};
export const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;
const mark = '<span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg></span>';

export const actionLabels = {
  authenticate: 'Rejected sign-in attempts', create_client: 'Created a client', issue_agent_credential: 'Issued a connector credential',
  revoke_agent_credential: 'Revoked a connector credential', verify_project: 'Changed project verification', review_brief: 'Reviewed a brief',
  resolve_conflict: 'Resolved a conflict', reveal_backtest: 'Revealed backtest results', get_policies: 'Read the rules', get_client_context: 'Read a client profile',
  get_incoming_tenders: 'Listed incoming tenders', search_tenders: 'Searched past awards', save_shortlist: 'Saved a shortlist',
  request_pricing: 'Requested pricing', submit_brief: 'Submitted a brief', unknown_tool: 'Called an unavailable tool',
};
const ruleLabels = { ERROR: 'error', VALIDATION: 'invalid input' };
const outcomeLabel = (row) => {
  const rule = row.rule_id ? ` · ${ruleLabels[row.rule_id] ?? row.rule_id}` : '';
  return { allowed: 'Allowed', approved: 'Approved', declined: 'Declined', blocked: `Blocked${rule}`, escalated: `Escalated${rule}` }[row.outcome] ?? row.outcome;
};
const outcomeClass = { allowed: '', approved: 'ok', declined: 'bad', blocked: 'bad', escalated: 'warn' };
export const outcomePill = (row) => `<span class="pill ${outcomeClass[row.outcome] ?? ''}">${esc(outcomeLabel(row))}</span>`;
const pct = (value) => (value === null ? 'n/a' : `${Math.round(value * 100)}%`);

const page = (title, body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Tender Desk</title><link rel="stylesheet" href="/console.css"></head><body>${body}</body></html>`;

const authPage = (title, inner) => page(title, `<main class="login"><a class="brand" href="/login">${mark}<span>Tender Desk</span></a>
${inner}</main>`);
const banner = (message, kind = 'bad') => (message ? `<p class="banner ${kind}" role="${kind === 'ok' ? 'status' : 'alert'}">${esc(message)}</p>` : '');

export function renderLogin(message, mode = 'secret', { notice, canReset = false } = {}) {
  const fields = mode === 'email'
    ? `<label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" required>
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required>`
    : '<label for="token">Admin secret</label><input id="token" name="token" type="password" autocomplete="off" required>';
  const hint = mode === 'email'
    ? 'Sign in with the admin account. Only that account can use this console.'
    : 'Paste the admin secret from <code>.local/admin-token.txt</code>. It is checked locally and never stored in the page.';
  return authPage('Sign in', `<h1>Admin sign-in</h1>
<p class="muted small">${hint}</p>
${banner(notice, 'ok')}${banner(message)}
<form method="post" action="/login">${fields}
<button class="primary" type="submit">Sign in</button></form>
${canReset ? '<p class="small"><a href="/forgot">Forgot password?</a></p>' : ''}`);
}

export function renderForgot({ sent = false, message } = {}) {
  return authPage('Reset password', `<h1>Reset your password</h1>
${sent ? `<p class="banner ok" role="status">If that address belongs to the admin account, a reset link is on its way. It expires soon and works once. Check your spam folder if it does not arrive.</p>
<p class="small"><a href="/login">Back to sign in</a></p>`
    : `<p class="muted small">Enter the admin email and we will send a link to choose a new password.</p>
${banner(message)}
<form method="post" action="/forgot"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" required>
<button class="primary" type="submit">Send reset link</button></form>
<p class="small"><a href="/login">Back to sign in</a></p>`}`);
}

export function renderReset({ token, message, invalid = false } = {}) {
  if (invalid) {
    return authPage('Reset password', `<h1>Link not valid</h1>
${banner('This reset link is invalid, expired, or already used.')}
<p class="small"><a href="/forgot">Send a new link</a></p>`);
  }
  return authPage('Choose a new password', `<h1>Choose a new password</h1>
<p class="muted small">Use at least 12 characters.</p>
${banner(message)}
<form method="post" action="/reset"><input type="hidden" name="token" value="${esc(token)}">
<label for="password">New password</label><input id="password" name="password" type="password" autocomplete="new-password" minlength="12" required>
<label for="confirm">Type it again</label><input id="confirm" name="confirm" type="password" autocomplete="new-password" minlength="12" required>
<button class="primary" type="submit">Change password</button></form>`);
}

const groupOf = { requests: 'Decisions', briefs: 'Decisions', conflicts: 'Decisions', clients: 'Clients', projects: 'Clients', backtest: 'Records', audit: 'Records' };

export function renderShell({ state, csrf, active, title, sub, crumbs = '', actions = '', flash, body }) {
  const pending = state.briefs.filter((b) => b.status === 'pending_approval').length;
  const waiting = (state.requests ?? []).filter((r) => r.status === 'requested').length;
  const openConflicts = state.conflicts.filter((c) => c.status === 'open').length;
  const unverified = state.projects.filter((p) => !p.verified).length;
  const badge = (n) => n ? `<span class="count">${n}</span>` : '';
  const navItem = (key, label, count) => `<a href="/${key === 'overview' ? '' : key}"${active === key ? ' aria-current="page"' : ''}>${icon(key)}<span>${label}</span>${count !== undefined ? badge(count) : ''}</a>`;
  const group = (label, items) => `<p class="nav-group">${label}</p>${items.join('\n')}`;
  const eyebrow = groupOf[active] ? `<p class="eyebrow">${groupOf[active]}</p>` : '';
  const flashBanner = flash ? `<p class="banner ${flash.ok ? 'ok' : 'bad'}" role="${flash.ok ? 'status' : 'alert'}">${esc(flash.text)}</p>` : '';
  return page(title, `<div class="app">
<nav class="side" aria-label="Main">
<a class="brand" href="/">${mark}<span>Tender Desk</span></a>
<div class="nav">
${navItem('overview', 'Overview')}
${group('Decisions', [navItem('requests', 'Brief requests', waiting), navItem('briefs', 'Briefs', pending), navItem('conflicts', 'Conflicts', openConflicts)])}
${group('Clients', [navItem('clients', 'Clients'), navItem('projects', 'Projects', unverified)])}
${group('Records', [navItem('backtest', 'Backtest'), navItem('audit', 'Audit log')])}
</div>
<div class="side-foot"><p class="env">Local only · fictional demo clients</p>
<form method="post" action="/logout"><input type="hidden" name="csrf" value="${esc(csrf)}"><button class="link" type="submit">Sign out</button></form></div>
</nav>
<main class="content">
${crumbs}
<div class="page-head"><div>${eyebrow}<h1>${esc(title)}</h1>${sub ? `<p class="sub">${sub}</p>` : ''}</div><div class="row-actions">${actions}</div></div>
${flashBanner}
${body}
</main></div>`);
}

export const form = (csrf, path, label, cls = '', back = '') => `<form method="post" action="${path}"><input type="hidden" name="csrf" value="${esc(csrf)}">${back ? `<input type="hidden" name="back" value="${esc(back)}">` : ''}<button class="${cls}" type="submit">${esc(label)}</button></form>`;

export function renderOverview({ state, dataset, csrf, flash }) {
  const clients = new Map(state.clients.map((c) => [c.id, c.name]));
  const contracts = new Map(dataset.contracts.map((c) => [c.tender_no, c]));
  const name = (id) => esc(clients.get(id) ?? 'Unknown client');

  const riskOrder = { high: 0, medium: 1, low: 2 };
  const pendingBriefs = state.briefs.filter((b) => b.status === 'pending_approval')
    .sort((a, b) => (riskOrder[a.risk_level] ?? 3) - (riskOrder[b.risk_level] ?? 3) || new Date(a.created_at) - new Date(b.created_at));
  const openConflicts = state.conflicts.filter((c) => c.status === 'open');
  const unverified = state.projects.filter((p) => !p.verified);
  const queue = [
    ...pendingBriefs.map((b) => ({ pill: '<span class="pill info">Brief</span>',
      title: `${recordCode('brief', b)} · ${b.recommendation === 'bid' ? 'Bid' : 'No-bid'} recommendation for <span class="num">${esc(b.tender_no)}</span> ${riskChip(b.risk_level)}`,
      sub: `${name(b.client_id)} · ${esc(contracts.get(b.tender_no)?.agency ?? 'Agency unknown')} · submitted ${ago(b.created_at)}`,
      action: `<a class="btn primary" href="${recordHref('brief', b)}">Review</a>` })),
    ...openConflicts.map((c) => ({ pill: '<span class="pill warn">Conflict</span>',
      title: `${recordCode('conflict', c)} · ${name(c.client_id)} submitted a brief on <span class="num">${esc(c.tender_no)}</span>`,
      sub: `Tender Desk already advises ${name(c.holder_client_id)} on it. Nothing was disclosed.`,
      action: `<a class="btn outline" href="${recordHref('conflict', c)}">Resolve</a>` })),
    ...unverified.map((p) => ({ pill: '<span class="pill">Project</span>',
      title: `${recordCode('project', p)} · ${esc(p.title)}`,
      sub: `${name(p.client_id)}${p.agency ? ` · ${esc(p.agency)}` : ''} · ${p.value_cents === null ? 'no value given' : `<span class="num">${money(p.value_cents)}</span>`} · not yet verified`,
      action: `<a class="btn outline" href="${recordHref('project', p)}">Check</a>` })),
  ];
  const waiting = pendingBriefs.length + openConflicts.length + unverified.length;

  const feed = state.audit.slice(0, 10).map((row) => {
    const who = row.client_id ? name(row.client_id) : isAdminActor(row.actor) ? 'You' : row.actor === 'unauthenticated' ? 'Unknown caller' : esc(row.actor);
    return `<li><div class="line"><span>${esc(actionLabels[row.action] ?? row.action)}</span>${outcomePill(row)}</div>
<p class="meta">${who}${row.tender_no ? ` · <span class="num">${esc(row.tender_no)}</span>` : ''} · ${ago(row.ts)}</p></li>`;
  });

  return renderShell({ state, csrf, active: 'overview', title: 'Overview', flash,
    sub: waiting ? `${plural(waiting, 'item')} need${waiting === 1 ? 's' : ''} your decision.` : 'Nothing is waiting for you.',
    body: `<div class="grid">
<section class="panel" aria-labelledby="q"><header><h2 id="q">Needs your decision</h2><span class="muted small">${plural(waiting, 'item')}</span></header>
${queue.length ? `<ul class="queue">${queue.map((item) => `<li>${item.pill}<div><strong>${item.title}</strong><span class="muted">${item.sub}</span></div><div class="row-actions">${item.action}</div></li>`).join('')}</ul>`
  : `<div class="empty"><strong>You're all caught up.</strong>Agent work that needs you lands here: briefs to review, pricing conflicts to resolve, projects to verify.</div>`}
</section>
<aside class="stack-gap">
<section class="panel" aria-labelledby="a"><header><h2 id="a">Recent activity</h2></header>
${feed.length ? `<ul class="feed">${feed.join('')}</ul>` : '<div class="empty">No activity yet.</div>'}
<div class="panel-foot"><span>Backtest: <span class="num">${state.backtest.revealed} of ${state.backtest.scoreable}</span> outcomes revealed</span><a href="/backtest">Open backtest</a></div>
</section>
</aside></div>` });
}

// Brief list filters live in the URL (defaults omitted) so any view can be linked and returned to.
export const briefFilters = Object.freeze({
  status: ['pending', 'approved', 'declined', 'all'], risk: ['any', 'high', 'medium', 'low'], sort: ['risk', 'newest', 'oldest'],
});
export function briefQuery(params) {
  const pick = (key) => (briefFilters[key].includes(params.get(key)) ? params.get(key) : briefFilters[key][0]);
  return { status: params.get('view') === 'decided' ? 'all' : pick('status'), risk: pick('risk'), sort: pick('sort') };
}
export function briefListHref(query) {
  const params = new URLSearchParams();
  for (const key of ['status', 'risk', 'sort']) if (query[key] !== briefFilters[key][0]) params.set(key, query[key]);
  const search = params.toString();
  return search ? `/briefs?${search}` : '/briefs';
}
const select = (name, label, options, current) => `<label>${label}<select name="${name}">${options.map(([value, text]) => `<option value="${value}"${value === current ? ' selected' : ''}>${text}</option>`).join('')}</select></label>`;

export function renderBriefs({ state, dataset, csrf, flash, query = briefQuery(new URLSearchParams()) }) {
  const clients = new Map(state.clients.map((c) => [c.id, c.name]));
  const contracts = new Map(dataset.contracts.map((c) => [c.tender_no, c]));
  const order = { high: 0, medium: 1, low: 2 };
  const list = state.briefs
    .filter((b) => query.status === 'all' || b.status === (query.status === 'pending' ? 'pending_approval' : query.status))
    .filter((b) => query.risk === 'any' || b.risk_level === query.risk)
    .sort((a, b) => (query.sort === 'risk' ? (order[a.risk_level] ?? 3) - (order[b.risk_level] ?? 3) : 0)
      || (query.sort === 'newest' ? new Date(b.created_at) - new Date(a.created_at) : new Date(a.created_at) - new Date(b.created_at)));
  const back = encodeURIComponent(briefListHref(query));
  const statusChip = (b) => ({ approved: '<span class="chip done">Approved</span>', declined: '<span class="chip danger">Declined</span>' }[b.status] ?? '<span class="chip progress">Pending</span>');
  const row = (b) => `<tr>
<td><a href="${recordHref('brief', b)}?back=${back}">${esc(recordCode('brief', b))} - ${esc(b.tender_no)}</a><span class="sub-line">${esc(contracts.get(b.tender_no)?.agency ?? 'Agency unknown')}</span></td>
<td>${esc(clients.get(b.client_id) ?? 'Unknown client')}</td>
<td>${statusChip(b)} ${riskChip(b.risk_level)}</td>
<td class="r num nowrap">${money(b.price_band.low_cents)} – ${money(b.price_band.high_cents)}</td>
<td class="muted num">${ago(b.created_at)}</td>
<td class="end"><a class="btn outline" href="${recordHref('brief', b)}?back=${back}">${b.status === 'pending_approval' ? 'Review' : 'Open'}</a></td></tr>`;
  return renderShell({ state, csrf, active: 'briefs', title: 'Briefs', flash,
    sub: 'Agents submit every brief as pending. Only you can approve or decline. Risk is computed by code and sorts the list; it is not a verdict.',
    body: `<form method="get" action="/briefs" class="filters">
${select('status', 'Status', [['pending', 'Waiting for approval'], ['approved', 'Approved'], ['declined', 'Declined'], ['all', 'All statuses']], query.status)}
${select('risk', 'Risk', [['any', 'Any risk'], ['high', 'High'], ['medium', 'Medium'], ['low', 'Low']], query.risk)}
${select('sort', 'Sort', [['risk', 'Highest risk first'], ['newest', 'Newest first'], ['oldest', 'Oldest first']], query.sort)}
<button class="outline" type="submit">Apply</button></form>
<section class="panel"><div class="table-wrap"><table class="stack">
<thead><tr><th>Brief</th><th>Client</th><th>Status</th><th class="r">Historical band</th><th>Submitted</th><th><span class="visually-hidden">Open</span></th></tr></thead>
<tbody>${list.length ? list.map(row).join('') : '<tr><td colspan="6"><div class="empty"><strong>No briefs in this view.</strong>When an agent submits one it appears here for your decision.</div></td></tr>'}</tbody>
</table></div></section>` });
}

export function renderConflicts({ state, csrf, flash }) {
  const clients = new Map(state.clients.map((c) => [c.id, c.name]));
  const name = (id) => esc(clients.get(id) ?? 'Unknown client');
  const open = state.conflicts.filter((c) => c.status === 'open');
  const resolved = state.conflicts.filter((c) => c.status === 'resolved').reverse();
  return renderShell({ state, csrf, active: 'conflicts', title: 'Conflicts', flash,
    sub: 'Tender Desk advises one client per tender. A second client submitting a brief is escalated to you; neither side learns about the other.',
    body: `<div class="stack-gap">
<section class="panel"><header><h2>Open</h2><span class="muted small">${plural(open.length, 'conflict')}</span></header>
${open.length ? `<ul class="queue">${open.map((c) => `<li><span class="pill warn">Conflict</span>
<div><strong>${recordLink('conflict', c, c.tender_no)} · ${name(c.client_id)} submitted a brief</strong>
<span class="muted">Tender Desk already advises ${name(c.holder_client_id)} on it. Nothing was disclosed.</span></div>
<div class="row-actions">${form(csrf, `/actions/conflict/${c.id}/serve-holder`, 'Keep advising the holder', 'outline')}${form(csrf, `/actions/conflict/${c.id}/stop`, 'Stop advising on this tender', 'outline')}</div></li>`).join('')}</ul>
<p class="note">Advice already given cannot be moved to a competitor.</p>`
  : `<div class="empty"><strong>No open conflicts.</strong>When two clients want pricing on the same tender, it lands here.</div>`}
</section>
${resolved.length ? `<section class="panel"><header><h2>Resolved</h2><span class="muted small">${plural(resolved.length, 'conflict')}</span></header><div class="table-wrap"><table class="stack">
<thead><tr><th>Tender</th><th>Asked</th><th>Resolution</th><th>When</th></tr></thead>
<tbody>${resolved.map((c) => `<tr><td>${recordLink('conflict', c, c.tender_no)}</td><td>${name(c.client_id)}</td>
<td>${c.resolution === 'serve_holder' ? `Kept advising ${name(c.holder_client_id)}` : 'Stopped advising'}</td><td class="muted num">${ago(c.created_at)}</td></tr>`).join('')}</tbody>
</table></div></section>` : ''}
</div>` });
}

export function renderClients({ state, csrf, flash, only }) {
  const clients = new Map(state.clients.map((c) => [c.id, c.name]));
  const name = (id) => esc(clients.get(id) ?? 'Unknown client');
  const unverified = state.projects.filter((p) => !p.verified);
  const verified = state.projects.filter((p) => p.verified);
  const projectsOnly = only === 'projects';
  return renderShell({ state, csrf, active: projectsOnly ? 'projects' : 'clients', title: projectsOnly ? 'Projects' : 'Clients', flash,
    sub: 'Agents record every self-reported project as unverified. Only you can verify one, and briefs may cite verified projects only.',
    body: `<div class="stack-gap">
<section class="panel"><header><h2>Projects to verify</h2><span class="muted small">${plural(unverified.length, 'project')}</span></header>
${unverified.length ? `<ul class="queue">${unverified.map((p) => `<li><span class="pill">Project</span>
<div><strong>${recordLink('project', p, p.title)}</strong><span class="muted">${name(p.client_id)}${p.agency ? ` · ${esc(p.agency)}` : ''} · ${p.value_cents === null ? 'no value given' : `<span class="num">${money(p.value_cents)}</span>`} · not yet verified</span></div>
<div class="row-actions"><a class="btn outline" href="${recordHref('project', p)}">Check and verify</a></div></li>`).join('')}</ul>`
  : `<div class="empty"><strong>Every reported project is verified.</strong>New self-reported projects appear here.</div>`}
</section>
${projectsOnly ? '' : `<section class="panel"><header><h2>Clients</h2><span class="muted small">${plural(state.clients.length, 'client')}</span></header><div class="table-wrap"><table class="stack">
<thead><tr><th>Name</th><th>Categories</th><th class="r">Team</th><th class="r">Largest contract</th><th class="r">Projects</th></tr></thead>
<tbody>${state.clients.map((c) => `<tr><td>${recordLink('client', c, c.name)}</td><td class="muted">${esc(c.categories.join(', '))}</td><td class="r num">${c.team_size}</td><td class="r num">${money(c.max_contract_cents)}</td>
<td class="r num">${state.projects.filter((p) => p.client_id === c.id && p.verified).length} of ${state.projects.filter((p) => p.client_id === c.id).length}</td></tr>`).join('')}</tbody>
</table></div></section>`}
${verified.length ? `<section class="panel"><header><h2>Verified projects</h2><span class="muted small">${plural(verified.length, 'project')}</span></header><div class="table-wrap"><table class="stack">
<thead><tr><th>Client</th><th>Project</th><th>Value</th><th><span class="visually-hidden">Action</span></th></tr></thead>
<tbody>${verified.map((p) => `<tr><td>${name(p.client_id)}</td><td>${recordLink('project', p, p.title)}</td><td class="num">${p.value_cents === null ? '<span class="muted">Not given</span>' : money(p.value_cents)}</td>
<td class="end">${form(csrf, `/actions/project/${p.id}/unverify`, 'Revoke', '')}</td></tr>`).join('')}</tbody>
</table></div></section>` : ''}
</div>` });
}

function meter(rate, tickAt = 0.5) {
  const pctFill = Math.round(rate * 100);
  const pctTick = Math.round(tickAt * 100);
  return `<svg class="meter" viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="Bar showing ${pctFill} percent">
<rect class="track" x="0" y="0" width="100" height="6" rx="3"></rect>
<rect class="fill" x="0" y="0" width="${Math.min(pctFill, 100)}" height="6" rx="3"></rect>
<line class="tick" x1="${pctTick}" x2="${pctTick}" y1="0" y2="8"></line></svg>`;
}

export function renderBacktest({ state, csrf, flash, filter = 'all' }) {
  const bt = state.backtest;
  const briefTenders = new Set([...state.briefs.map((b) => b.tender_no), ...state.holds.map((h) => h.tender_no)]);
  const briefBand = (tenderNo) => state.briefs.find((b) => b.tender_no === tenderNo)?.price_band;
  const rows = bt.rows.filter((row) => filter === 'all' || (filter === 'inside' ? row.in_band : !row.in_band));
  const awaiting = bt.pending.filter((p) => briefTenders.has(p.tender_no));
  const tab = (key, label, n) => `<a href="/backtest${key === 'all' ? '' : `?filter=${key}`}"${filter === key ? ' aria-current="page"' : ''}>${label} <span class="n">${n}</span></a>`;
  const scoreRow = ({ prediction: p, in_band: inBand, incumbent_won: won }) => {
    const brief = briefBand(p.tender_no);
    const briefHit = brief && p.actual_cents >= brief.low_cents && p.actual_cents <= brief.high_cents;
    return `<tr>
<td><span class="tender">${esc(p.tender_no)}</span><span class="sub-line">${esc(p.agency)}</span></td>
<td class="r num nowrap">${money(p.band.low_cents)} – ${money(p.band.high_cents)}<span class="sub-line muted">${p.n} comparables · ${p.tier === 'agency' ? 'same agency' : 'same category'}</span></td>
<td class="r num">${money(p.actual_cents)}${brief ? `<span class="sub-line muted">Client brief band ${briefHit ? 'held' : 'missed'}</span>` : ''}</td>
<td>${inBand ? '<span class="pill ok">Inside band</span>' : '<span class="pill bad">Outside band</span>'}</td>
<td>${p.incumbent ? `${esc(p.incumbent)}<span class="sub-line muted">${won ? 'Won' : 'Did not win'}</span>` : '<span class="muted">None predicted</span>'}</td>
<td>${esc(p.actual_suppliers.join(', ') || 'None recorded')}</td></tr>`;
  };
  const actions = bt.revealed < bt.scoreable ? `<a class="btn outline" href="/backtest/reveal-all">Reveal all ${bt.scoreable - bt.revealed} remaining outcomes…</a>` : '';
  return renderShell({ state, csrf, active: 'backtest', title: 'Backtest', actions, flash,
    sub: '2026 awards the agents saw as incoming tenders, with the winner and amount hidden. Predictions use only earlier awards. Reveal shows the real outcome and cannot be undone.',
    body: `<div class="stack-gap">
${bt.revealed ? `<section class="panel rates" aria-label="Hit rates">
<div class="rate"><span class="label">Price band held the actual award</span><span class="big">${pct(bt.band_rate)}</span>
<span class="muted small">${bt.band_hits} of ${bt.revealed} revealed outcomes</span>${meter(bt.band_rate ?? 0)}<span class="muted small">50% expected by design · 25th–75th percentile band</span></div>
<div class="rate"><span class="label">Predicted incumbent won</span><span class="big">${pct(bt.incumbent_rate)}</span>
<span class="muted small">${bt.incumbent_hits} of ${bt.incumbent_scored} with a predicted incumbent</span>${meter(bt.incumbent_rate ?? 0)}</div>
</section>` : `<section class="panel"><div class="empty"><strong>Nothing revealed yet.</strong>Reveal a tender below to compare the prediction with the real award.</div></section>`}
${awaiting.length ? `<section class="panel"><header><h2>Tenders agents have worked on</h2><span class="muted small">${plural(awaiting.length, 'tender')}</span></header><div class="table-wrap"><table class="stack">
<thead><tr><th>Tender</th><th>Agency</th><th class="r">Predicted band</th><th><span class="visually-hidden">Action</span></th></tr></thead>
<tbody>${awaiting.map((p) => `<tr><td><span class="tender">${esc(p.tender_no)}</span></td><td>${esc(p.agency)}</td><td class="r num nowrap">${money(p.band.low_cents)} – ${money(p.band.high_cents)}</td>
<td class="end">${form(csrf, `/actions/backtest/${encodeURIComponent(p.tender_no)}/reveal`, 'Reveal outcome', 'primary')}</td></tr>`).join('')}</tbody>
</table></div></section>` : ''}
${bt.revealed ? `<nav class="tabs" aria-label="Backtest results">
${tab('all', 'All', bt.revealed)}${tab('inside', 'Inside band', bt.band_hits)}${tab('outside', 'Outside band', bt.revealed - bt.band_hits)}
</nav>
<section class="panel"><div class="table-wrap"><table class="stack">
<thead><tr><th>Tender</th><th class="r">Predicted band</th><th class="r">Actual award</th><th>Result</th><th>Predicted incumbent</th><th>Actual winner</th></tr></thead>
<tbody>${rows.length ? rows.slice(0, 25).map(scoreRow).join('') : '<tr><td colspan="6"><div class="empty">No outcomes in this view.</div></td></tr>'}</tbody>
</table></div>
<div class="panel-foot"><span class="muted">Showing ${Math.min(25, rows.length)} of ${plural(rows.length, 'outcome')}. The rates above cover all ${bt.revealed}.</span></div></section>` : ''}
<p class="muted small">${bt.revealed < bt.scoreable ? 'Revealing only some tenders gives a partial score; reveal all for the full-sample rate. ' : ''}${bt.unscoreable} hold-out contracts are excluded: no award amount, or fewer than five comparables.</p>
</div>` });
}

export const auditFilters = Object.freeze({ rule: ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'VALIDATION', 'ERROR'], outcome: ['allowed', 'blocked', 'escalated', 'approved', 'declined'] });

export function renderAudit({ state, csrf, flash, rows = state.audit.slice(0, 100), filters = {} }) {
  const clients = new Map(state.clients.map((c) => [c.id, c.name]));
  const opt = (values, current, anyLabel) => [['', anyLabel], ...values.map((v) => [v, v])];
  return renderShell({ state, csrf, active: 'audit', title: 'Audit log', flash,
    sub: 'Every agent and admin action, allowed or blocked, written in the same transaction as the change.',
    body: `<form method="get" action="/audit" class="filters">
<label>Search<input type="search" name="q" maxlength="120" value="${esc(filters.q ?? '')}" placeholder="AUD00042, action or reason"></label>
<label>Client<input name="client" maxlength="20" value="${esc(filters.client ?? '')}" placeholder="CLI00003"></label>
<label>Tender<input name="tender" maxlength="100" value="${esc(filters.tender ?? '')}"></label>
${select('rule', 'Rule', opt(auditFilters.rule, filters.rule, 'Any rule'), filters.rule ?? '')}
${select('outcome', 'Outcome', opt(auditFilters.outcome, filters.outcome, 'Any outcome'), filters.outcome ?? '')}
<button class="outline" type="submit">Apply</button></form>
<section class="panel"><div class="table-wrap"><table class="stack">
<thead><tr><th>Ref</th><th>Time</th><th>Actor</th><th>Action</th><th>Outcome</th><th>Tender</th></tr></thead>
<tbody>${rows.length ? rows.map((row) => {
      const who = row.client_id ? esc(clients.get(row.client_id) ?? 'Client') : isAdminActor(row.actor) ? 'You' : row.actor === 'unauthenticated' ? 'Unknown caller' : esc(row.actor);
      return `<tr><td class="num nowrap">${recordLink('audit', row)}</td><td class="num nowrap">${stamp(row.ts)}</td><td>${who}</td><td>${esc(actionLabels[row.action] ?? row.action)}</td><td>${outcomePill(row)}</td><td class="num">${esc(row.tender_no ?? '')}</td></tr>`;
    }).join('') : '<tr><td colspan="6"><div class="empty">No activity yet.</div></td></tr>'}</tbody>
</table></div><div class="panel-foot"><span class="muted">Showing the latest ${plural(rows.length, 'entry')}.</span></div></section>` });
}

export function renderRevealConfirm({ state, csrf, flash }) {
  const remaining = state.backtest.scoreable - state.backtest.revealed;
  return renderShell({ state, csrf, active: 'backtest', title: 'Reveal all outcomes?', flash,
    crumbs: '<nav class="crumbs" aria-label="Breadcrumb"><a href="/backtest">Backtest</a> / <span>Reveal all</span></nav>',
    body: remaining > 0 ? `<section class="panel"><header><h2>This cannot be undone</h2></header>
<div class="prose">Revealing shows the real winner and award amount for ${plural(remaining, 'hold-out tender')}. Once shown they stay shown, because the reveal is recorded in the append-only audit log. Revealing one tender at a time keeps the scoreboard a live demonstration; revealing everything spends it.</div>
<div class="decision"><p class="muted small">Recorded in the audit log under your name.</p><div class="row-actions">
<a class="btn outline" href="/backtest">Cancel</a>
<form method="post" action="/actions/backtest/all/reveal"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="confirm" value="yes"><button class="primary" type="submit">Yes, reveal all ${remaining}</button></form>
</div></div></section>` : '<section class="panel"><div class="empty"><strong>Everything is already revealed.</strong><a href="/backtest">Back to the backtest</a></div></section>' });
}

const requestStatus = { requested: ['Waiting for a draft', 'progress'], drafted: ['Draft in review', 'progress'], approved: ['Approved', 'done'],
  declined: ['Declined', 'danger'], cancelled: ['Cancelled', ''] };

// Paid brief requests from customers: draft (or redraft) with AI, or decline with a reason the customer reads.
export function renderRequests({ state, csrf, flash, rows, aiReady }) {
  const briefs = new Map(state.briefs.map((b) => [b.id, b]));
  const items = rows.map((r) => {
    const [label, chip] = requestStatus[r.status] ?? [r.status, ''];
    const brief = r.brief_id ? briefs.get(r.brief_id) : undefined;
    const waiting = r.status === 'requested';
    const draftAction = !waiting ? '' : aiReady
      ? form(csrf, `/actions/request/${r.id}/draft`, r.last_error ? 'Redraft' : 'Draft', 'primary', '/requests')
      : '<span class="muted small">AI drafting is not configured (TD_OPENROUTER_KEY).</span>';
    const decline = waiting ? `<form class="decline" method="post" action="/actions/request/${esc(r.id)}/decline"><input type="hidden" name="csrf" value="${esc(csrf)}">
<label for="reason-${esc(r.id)}">Reason the customer will read</label><textarea id="reason-${esc(r.id)}" name="reason" rows="2" maxlength="500"></textarea>
<div><button type="submit">Decline</button></div></form>` : '';
    return `<li><div><span class="num">${esc(r.reference)}</span><br>${r.closed ? '<span class="chip danger">Closed</span>' : ''}</div>
<div><strong>${esc(r.title)}</strong><span class="muted">${esc(r.client_name)} · ${esc(r.agency ?? '')} · <span class="num">${esc(r.tender_no)}</span></span>
<span class="muted">${r.payment_status === 'test' ? 'Test payment' : esc(r.payment_status ?? 'No payment')} · ${money(r.amount_cents ?? 0)} · requested ${esc(ago(r.created_at))}</span>
${r.last_error ? `<span class="muted">Last draft failed: ${esc(r.last_error)}</span>` : ''}
${brief ? `<span>${recordLink('brief', brief)}</span>` : ''}${decline}</div>
<div class="row-actions"><span class="chip ${chip}">${esc(label)}</span>${draftAction}</div></li>`;
  });
  const body = `<section class="panel"><header><h2>Requests</h2><span class="muted small">${plural(rows.filter((r) => r.status === 'requested').length, 'waiting request')}</span></header>
${items.length ? `<ul class="queue">${items.join('')}</ul>` : '<p class="empty"><strong>No brief requests yet.</strong>Paid requests from customers appear here.</p>'}</section>`;
  return renderShell({ state, csrf, active: 'requests', title: 'Brief requests', flash,
    sub: 'Customers paid (in test mode) for a reviewed brief. Draft it with AI, then approve or decline the brief. A request you decline frees the tender.', body });
}
