// One page per record, each at a stable URL keyed by its readable reference (BRF00012, CLI00003 …).
// Every mention of another record links to that record's page.
import { renderBriefHtml } from './brief-render.mjs';
import { crossCheckProject } from './gebiz-check.mjs';
import { referenceCode, referenceLabel } from './references.mjs';
import { profileGaps } from './profile-help.mjs';
import { actionLabels, ago, decisionForms, esc, form, icon, money, notesPanel, outcomePill, plural, renderShell, stamp } from './console-view.mjs';

// Audit rows written by the admin: 'admin' today, an older operator name on rows from before the rename. Agents,
// customers and rejected callers always carry their own prefix, so anything else is the admin.
export const isAdminActor = (actor) => !/^(agent|customer):|^unauthenticated$/.test(String(actor ?? ''));

export const recordKinds = Object.freeze({
  client: { prefix: 'CLI', path: '/clients', list: 'Clients', active: 'clients' },
  project: { prefix: 'PRJ', path: '/projects', list: 'Clients', listPath: '/clients', active: 'clients' },
  brief: { prefix: 'BRF', path: '/briefs', list: 'Briefs', active: 'briefs' },
  conflict: { prefix: 'CON', path: '/conflicts', list: 'Conflicts', active: 'conflicts' },
  audit: { prefix: 'AUD', path: '/audit', list: 'Audit log', active: 'audit' },
});

const numberOf = (kind, row) => (kind === 'audit' ? row.id : row.reference_number);
export const recordCode = (kind, row) => referenceCode(recordKinds[kind].prefix, numberOf(kind, row));
export const recordHref = (kind, row) => `${recordKinds[kind].path}/${recordCode(kind, row)}`;
export const recordLink = (kind, row, subject = '') => (row
  ? `<a href="${recordHref(kind, row)}">${esc(referenceLabel(recordKinds[kind].prefix, numberOf(kind, row), subject))}</a>`
  : '<span class="muted">Unknown</span>');

const toneClass = { progress: 'progress', done: 'done', warning: 'warning', danger: 'danger', neutral: 'neutral' };
export const chip = (label, tone = 'neutral') => `<span class="chip ${toneClass[tone]}">${esc(label)}</span>`;
export const riskChip = (level) => ({ high: chip('High risk', 'danger'), medium: chip('Medium risk', 'warning') }[level] ?? chip('Low risk', 'neutral'));
export const briefChip = (status) => ({ approved: chip('Approved', 'done'), declined: chip('Declined', 'danger') }[status] ?? chip('Pending', 'progress'));
const verifiedChip = (p) => (p.verified ? chip('Verified', 'done') : chip('Unverified', 'progress'));
const conflictChip = (c) => (c.status === 'open' ? chip('Open', 'progress') : chip('Resolved', 'done'));

function lookups(state) {
  const clients = new Map(state.clients.map((c) => [c.id, c]));
  const projects = new Map(state.projects.map((p) => [p.id, p]));
  return {
    client: (id) => clients.get(id),
    project: (id) => projects.get(id),
    clientLink: (id) => recordLink('client', clients.get(id), clients.get(id)?.name),
    projectLink: (id) => recordLink('project', projects.get(id), projects.get(id)?.title),
  };
}
export const tenderLink = (tenderNo) => `<a class="num" href="/tenders/${encodeURIComponent(tenderNo)}">${esc(tenderNo)}</a>`;
const crumbs = (kind, code) => `<nav class="crumbs" aria-label="Breadcrumb"><a href="${recordKinds[kind].listPath ?? recordKinds[kind].path}">${recordKinds[kind].list}</a> / <span class="num">${esc(code)}</span></nav>`;
const props = (pairs) => `<dl class="props">${pairs.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join('')}</dl>`;
const panel = (title, inner, extra = '') => `<section class="panel"><header><h2>${esc(title)}</h2>${extra}</header>${inner}</section>`;
const list = (items, empty) => (items.length ? `<ul class="feed">${items.map((i) => `<li>${i}</li>`).join('')}</ul>` : `<div class="empty">${esc(empty)}</div>`);

export function renderNotFound({ state, csrf, kind }) {
  const k = recordKinds[kind] ?? recordKinds.brief;
  return renderShell({ state, csrf, active: k.active, title: 'Not found',
    body: `<section class="panel"><div class="empty"><strong>No record with that reference.</strong><a href="${k.listPath ?? k.path}">Back to ${esc(k.list)}</a></div></section>` });
}

// The awards behind a brief's band. An award more than five times off the median is flagged so an odd match stands out.
function comparablesPanel(snapshot, dataset, band) {
  if (!snapshot?.comparables?.length) return '';
  const byNumber = new Map(dataset.contracts.map((c) => [c.tender_no, c]));
  const median = Number(band?.median_cents ?? 0);
  const rows = snapshot.comparables.map((c) => ({ ...byNumber.get(c.tender_no), cents: Number(c.total_awarded_cents) }))
    .sort((a, b) => b.cents - a.cents).slice(0, 30).map((c) => {
      const odd = median && (c.cents > 5 * median || c.cents * 5 < median);
      return `<tr><td class="num nowrap">${esc(c.tender_no)}</td><td>${esc(c.description ?? '')}<span class="sub-line muted">${esc(c.agency ?? '')}</span></td>
<td class="r num nowrap">${money(c.cents)}${odd ? ' <span class="chip warning">Far from median</span>' : ''}</td><td class="num nowrap">${esc(c.last_award_date ?? '')}</td></tr>`;
    }).join('');
  return `<section class="panel"><header><h2>Comparable awards</h2><span class="muted small">${snapshot.comparables.length} awards, largest first${snapshot.comparables.length > 30 ? ' (first 30)' : ''}</span></header>
<div class="table-wrap"><table class="stack"><thead><tr><th>Tender</th><th>Description</th><th class="r">Awarded</th><th>Date</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

export function renderBriefDetail({ state, dataset, csrf, flash, brief, back, snapshot }) {
  const { client, project, clientLink, projectLink } = lookups(state);
  const code = recordCode('brief', brief);
  const tender = dataset.contracts.find((c) => c.tender_no === brief.tender_no) ?? state.openTenders?.find((t) => t.tender_no === brief.tender_no);
  const cited = brief.credentials_cited.map(project).filter(Boolean);
  const badCites = cited.filter((p) => !p.verified);
  const hold = state.holds.find((h) => h.tender_no === brief.tender_no);
  const holdOk = hold && hold.state === 'held' && hold.client_id === brief.client_id;
  const conflicts = state.conflicts.filter((c) => c.tender_no === brief.tender_no);
  const n = state.comparables.find((s) => s.client_id === brief.client_id && s.tender_no === brief.tender_no && s.stat_id === brief.stat_id)?.n;
  const check = (cls, iconName, title, sub) => `<li><span class="${cls}">${icon(iconName)}</span><div><span class="t">${title}</span>${sub ? `<span class="sub-line muted">${sub}</span>` : ''}</div></li>`;
  const holdNote = !hold ? 'No client holds the advice slot for this tender.' : hold.state === 'stopped' ? 'Advice on this tender was stopped.' : 'Another client holds the advice slot.';
  const checks = [
    holdOk ? check('ok', 'check', 'Advice slot held by this client', `Taken ${ago(hold.created_at)}`) : check('bad', 'cross', 'No active advice slot', holdNote),
    brief.credentials_cited.length === 0 ? check('ok', 'check', 'Cites no projects', 'Acceptable, for example a no-bid.')
      : badCites.length === 0 ? check('ok', 'check', 'All cited projects verified', cited.map((p) => projectLink(p.id)).join(', '))
        : check('bad', 'cross', 'A cited project is not verified', badCites.map((p) => projectLink(p.id)).join(', ')),
    check('warn', 'alert', 'Human review required', 'You read the prose; it is not semantically checked.'),
  ];
  const facts = brief.risk_facts ?? [];
  const decided = brief.status !== 'pending_approval';
  const banner = decided ? `<p class="banner ${brief.status === 'approved' ? 'ok' : 'bad'}" role="status">This brief was ${brief.status}${brief.decline_reason ? `: ${esc(brief.decline_reason)}` : '.'}</p>` : '';
  const parts = brief.parts ?? {};
  const lines = (items) => esc((items ?? []).join('\n'));
  const bands = [['below_lower_quartile', 'Below the lower quartile'], ['lower_quartile_to_median', 'Lower quartile to median'],
    ['median_to_upper_quartile', 'Median to upper quartile'], ['above_upper_quartile', 'Above the upper quartile']];
  const editor = decided ? '' : `<section class="panel"><header><h2>Edit or redraft</h2><span class="muted small">AI drafts it; you can edit any part before approving</span></header>
<form method="post" action="/actions/brief/${brief.id}/edit" class="form-grid"><input type="hidden" name="csrf" value="${esc(csrf)}">
<label>Recommendation <select name="recommendation"><option value="bid"${brief.recommendation === 'bid' ? ' selected' : ''}>Bid</option><option value="no-bid"${brief.recommendation === 'no-bid' ? ' selected' : ''}>Do not bid</option></select></label>
<label>Reasons, one per line <textarea name="reasons" rows="4">${lines(parts.reasons)}</textarea></label>
<label>Where to price <select name="band">${bands.map(([v, l]) => `<option value="${v}"${parts.price_position?.band === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
<label>Why price there <textarea name="why" rows="2">${esc(parts.price_position?.why ?? '')}</textarea></label>
<label>Questions to ask the agency, one per line <textarea name="questions" rows="3">${lines(parts.questions)}</textarea></label>
<label>Risks, one per line <textarea name="risks" rows="2">${lines(parts.risks)}</textarea></label>
<div><button type="submit">Save edits</button></div></form>
<form method="post" action="/actions/brief/${brief.id}/redraft" class="form-grid"><input type="hidden" name="csrf" value="${esc(csrf)}">
<label>Or redraft with a note for the AI <textarea name="note" rows="2" maxlength="1000" placeholder="Mention their school programmes; the scope is not small."></textarea></label>
<div><button type="submit">Redraft</button></div></form></section>`;
  // A slim bar: Approve, and Decline tucked behind a disclosure so the reason box only takes space when needed.
  const actions = decided ? '' : `<div class="decision">
<div class="row-actions"><form method="post" action="/actions/brief/${brief.id}/approve"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="revision" value="${esc(brief.revision ?? '')}"><button class="primary" type="submit">Approve</button></form>
<span class="muted small">Approval re-checks the advice slot and the citations.</span></div>
<div class="decisions">${decisionForms({ csrf, requestId: brief.request_id, declineAction: `/actions/brief/${brief.id}/decline` })}</div></div>`;
  const owner = client(brief.client_id);
  const verifiedCount = state.projects.filter((p) => p.client_id === brief.client_id && p.verified).length;
  const closes = brief.closes_at ? new Date(brief.closes_at) : null;
  const daysLeft = closes ? Math.ceil((closes.getTime() - Date.now()) / 86400000) : null;
  const dayText = (date) => date.toLocaleDateString('en-SG', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Singapore' });
  const sub = [esc(brief.tender_agency ?? tender?.agency ?? 'Agency not given'), `<span class="num">${esc(brief.tender_no)}</span>`,
    closes ? `Closes ${dayText(closes)}${daysLeft !== null && daysLeft >= 0 ? ` (${daysLeft === 0 ? 'today' : `in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`})` : ' (closed)'}` : 'No closing date'].join(' · ');
  const clientPanel = owner ? panel('Client', props([
    ['Company', clientLink(brief.client_id)],
    ['UEN', owner.uen ? `<span class="num">${esc(owner.uen)}</span>` : '<span class="muted">Not given</span>'],
    ['Categories', esc((owner.categories ?? []).join(', '))],
    ['Team size', esc(owner.team_size)],
    ['Largest contract', money(owner.max_contract_cents)],
    ['Verified projects', esc(verifiedCount)],
    ['Profile gaps', (() => {
      const gaps = profileGaps({ client: owner, projects: state.projects.filter((p) => p.client_id === brief.client_id), terms: snapshot?.filters?.query ? [snapshot.filters.query] : [] });
      return gaps.length ? `<ul class="bullets">${gaps.map((g) => `<li>${esc(g.message)}</li>`).join('')}</ul>` : '<span class="muted">None</span>';
    })()],
  ])) : '';
  const requirementsPanel = brief.requirements_text ? panel('Requirements the client pasted', `<div class="prose"><p>${esc(brief.requirements_text).replace(/\n/g, '<br>')}</p></div>`) : '';

  const backLink = back ? `<p class="small"><a href="${esc(back)}">Back to Briefs</a></p>` : '';
  return renderShell({ state, csrf, active: 'briefs', title: `${code} - ${brief.tender_title ?? tender?.description ?? brief.tender_no}`, sub, flash, crumbs: crumbs('brief', code) + backLink,
    actions: `${riskChip(brief.risk_level)} ${briefChip(brief.status)}`,
    body: `${banner}<div class="detail"><div class="stack-gap">
${panel('Risk facts', facts.length ? `<ul class="checks">${facts.map((f) => check('warn', 'alert', esc(f.message), '')).join('')}</ul>` : '<div class="empty">No risk facts fired.</div>',
    '<span class="muted small">Computed by code, not by an agent. The level is a sort key, not a verdict.</span>')}
<section class="panel"><header><h2>Agent's draft (not checked for meaning)</h2><span class="muted small">${clientLink(brief.client_id)}</span></header>
<div class="prose brief-prose">${renderBriefHtml(brief.content)}</div>
<p class="note">Prose is not semantically checked; you are the check.</p></section>
${requirementsPanel}
${notesPanel((state.notes ?? []).filter((n) => n.subject_id === brief.id || n.subject_id === state.requests?.find((r) => r.brief_id === brief.id)?.id))}
${editor}
${comparablesPanel(snapshot, dataset, brief.price_band)}</div>
<aside class="stack-gap">
${clientPanel}
${panel('Details', props([
    ['Client', clientLink(brief.client_id)],
    ['Tender', tenderLink(brief.tender_no)],
    ['Agency', esc(brief.tender_agency ?? tender?.agency ?? 'Not given')],
    ['Recommendation', brief.recommendation === 'bid' ? chip('Bid', 'progress') : chip('No-bid')],
    ['Historical band', `<span class="num">Lower quartile ${money(brief.price_band.low_cents)} · median ${money(brief.price_band.median_cents)} · upper quartile ${money(brief.price_band.high_cents)}</span><span class="sub-line muted">${n ? `${n} comparable awards` : ''}${snapshot?.filters?.query ? ` for "${esc(snapshot.filters.query)}"` : ''}</span>${snapshot?.thin || (n && n < 10) ? '<span class="sub-line"><span class="chip warning">Thin evidence: the customer sees no quartiles</span></span>' : ''}`],
    ['Conflicts', conflicts.length ? conflicts.map((c) => recordLink('conflict', c, c.tender_no)).join('<br>') : '<span class="muted">None</span>'],
    ['Submitted', stamp(brief.created_at)],
    ...(brief.decided_at ? [['Decided', stamp(brief.decided_at)]] : []),
  ]))}
${panel('Before you decide', `<ul class="checks">${checks.join('')}</ul><p class="note">Blocked approvals keep the brief pending and explain the rule.</p>`)}
</aside></div>${actions}` });
}

export function renderProjectDetail({ state, dataset, csrf, flash, project }) {
  const { client, clientLink } = lookups(state);
  const code = recordCode('project', project);
  const back = recordHref('project', project);
  const owner = client(project.client_id);
  const check = crossCheckProject(dataset, project, owner?.name ?? '', new Set(state.revealed));
  const resultChip = { match: chip('GeBIZ match', 'done'), no_match: chip('No GeBIZ match', 'warning') }[check.result] ?? chip('Not checked', 'neutral');
  const history = state.audit.filter((row) => row.summary?.project_id === project.id);
  const verifyForm = `<form method="post" action="/actions/project/${project.id}/verify" class="decline"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="back" value="${esc(back)}">
<label for="verify-note">Note (required without a GeBIZ match)</label>
<textarea id="verify-note" name="note" maxlength="500" rows="3"${check.result === 'match' ? '' : ' required'}></textarea>
<button class="primary" type="submit">Verify project</button></form>`;
  return renderShell({ state, csrf, active: 'clients', title: `${code} - ${project.title}`, flash, crumbs: crumbs('project', code),
    actions: `${verifiedChip(project)} ${resultChip}`,
    body: `<div class="detail"><div class="stack-gap">
${panel('GeBIZ cross-check', `<ul class="feed">${check.lines.map((line) => `<li>${esc(line)}</li>`).join('')}</ul>
<p class="note">Facts from the public GeBIZ awards. Exact name comparison only; you decide.</p>
<p class="note"><strong>Confirm on bizfile that ${esc(owner?.name ?? 'this client')} has UEN ${esc(owner?.uen ?? '(none given)')}</strong> before verifying. The client types its own company name, so a GeBIZ name match proves the award exists, not that this client is that company.</p>`)}
${panel(project.verified ? 'Verified' : 'Verify this project', project.verified
    ? `<p>${project.verified_at ? `Verified ${stamp(project.verified_at)}.` : 'Verified.'}</p>${form(csrf, `/actions/project/${project.id}/unverify`, 'Revoke verification', 'outline', back)}`
    : verifyForm)}
</div><aside class="stack-gap">
${panel('Details', props([
    ['Client', clientLink(project.client_id)],
    ['Agency claimed', esc(project.agency ?? 'Not given')],
    ['Value claimed', project.value_cents === null ? '<span class="muted">Not given</span>' : `<span class="num">${money(project.value_cents)}</span>`],
    ['GeBIZ tender no.', project.gebiz_tender_no ? `<span class="num">${esc(project.gebiz_tender_no)}</span>` : '<span class="muted">Not given</span>'],
    ['Note', project.verification_note ? esc(project.verification_note) : '<span class="muted">None</span>'],
  ]))}
${panel('History', list(history.map((row) => `${recordLink('audit', row, actionLabels[row.action] ?? row.action)} ${outcomePill(row)} <span class="muted">${ago(row.ts)}</span>`), 'No recorded changes yet.'))}
</aside></div>` });
}

export function renderClientDetail({ state, csrf, flash, client }) {
  const { clientLink } = lookups(state);
  const code = recordCode('client', client);
  const projects = state.projects.filter((p) => p.client_id === client.id);
  const briefs = state.briefs.filter((b) => b.client_id === client.id).reverse();
  const conflicts = state.conflicts.filter((c) => c.client_id === client.id || c.holder_client_id === client.id);
  const connectors = state.credentials.filter((c) => c.client_id === client.id);
  const back = recordHref('client', client);
  const shortlist = (state.shortlists ?? []).filter((s) => s.client_id === client.id);
  return renderShell({ state, csrf, active: 'clients', title: `${code} - ${client.name}`, flash, crumbs: crumbs('client', code),
    body: `<div class="detail"><div class="stack-gap">
${panel('Projects', list(projects.map((p) => `${recordLink('project', p, p.title)} ${verifiedChip(p)}`), 'No projects reported.'), `<span class="muted small">${plural(projects.length, 'project')}</span>`)}
${panel('Briefs', list(briefs.map((b) => `${recordLink('brief', b, b.tender_no)} ${briefChip(b.status)} ${b.status === 'pending_approval' ? riskChip(b.risk_level) : ''}`), 'No briefs yet.'))}
${panel('Conflicts', list(conflicts.map((c) => `${recordLink('conflict', c, c.tender_no)} ${conflictChip(c)} <span class="muted">${c.client_id === client.id ? 'escalated' : 'holds the slot'}</span>`), 'No conflicts.'))}
</div><aside class="stack-gap">
${panel('Profile', props([
    ['Categories', esc(client.categories.join(', '))],
    ['Capabilities', esc(client.capabilities)],
    ['Team', `<span class="num">${client.team_size}</span>`],
    ['Largest contract', `<span class="num">${money(client.max_contract_cents)}</span>`],
    ['Connector issued', connectors.length ? connectors.map((c) => `${stamp(c.created_at)} ${form(csrf, `/actions/credential/${c.id}/revoke`, 'Revoke connector', 'link', back)}`).join('<br>') : '<span class="muted">None (revoked or never issued)</span>'],
    ['Joined', stamp(client.created_at)],
  ]))}
${panel('Shortlist', list(shortlist.map((s) => `${tenderLink(s.tender_no)} <span class="num">${s.fit_score}</span><span class="sub-line muted">${esc(s.reasons.join('; '))}</span>`), 'Nothing shortlisted yet.'), '<span class="muted small">Saved by the client\'s agent; fit scores are the agent\'s.</span>')}
</aside></div>` });
}

export function renderConflictDetail({ state, csrf, flash, conflict }) {
  const { client, clientLink } = lookups(state);
  const code = recordCode('conflict', conflict);
  const back = recordHref('conflict', conflict);
  const hold = state.holds.find((h) => h.tender_no === conflict.tender_no);
  const holder = client(conflict.holder_client_id);
  const resolution = { serve_holder: 'Kept advising the holder', serve_neither: 'Stopped advising on this tender' }[conflict.resolution];
  return renderShell({ state, csrf, active: 'conflicts', title: `${code} - ${conflict.tender_no}`, flash, crumbs: crumbs('conflict', code),
    actions: conflictChip(conflict),
    body: `<div class="stack-gap">
${panel('What happened', props([
    ['Tender', tenderLink(conflict.tender_no)],
    ['Escalated client', clientLink(conflict.client_id)],
    ['Holds the advice slot', clientLink(conflict.holder_client_id)],
    ['Slot state', hold ? (hold.state === 'held' ? chip('Held', 'progress') : chip('Stopped')) : '<span class="muted">None</span>'],
    ['Raised', stamp(conflict.created_at)],
    ...(resolution ? [['Resolution', esc(resolution)]] : []),
  ]))}
${conflict.status === 'open' ? `<div class="decision"><p class="muted small">Neither client sees the other. Advice already given is never transferred.</p><div class="row-actions">
${form(csrf, `/actions/conflict/${conflict.id}/serve-holder`, 'Keep advising the holder', 'primary', back)}
${form(csrf, `/actions/conflict/${conflict.id}/stop`, 'Stop advising on this tender', 'outline', back)}</div>
<p class="muted small">The holder is ${esc(holder?.name ?? 'unknown')}.</p></div>` : ''}
</div>` });
}

export function renderAuditDetail({ state, csrf, flash, entry }) {
  const { clientLink } = lookups(state);
  const code = recordCode('audit', entry);
  const s = entry.summary ?? {};
  const linked = [
    s.brief_id && recordLink('brief', state.briefs.find((b) => b.id === s.brief_id), s.brief_reference ?? ''),
    s.conflict_id && recordLink('conflict', state.conflicts.find((c) => c.id === s.conflict_id), ''),
    s.project_id && recordLink('project', state.projects.find((p) => p.id === s.project_id), ''),
  ].filter(Boolean);
  const who = isAdminActor(entry.actor) ? 'You (admin)' : entry.actor === 'unauthenticated' ? 'Unknown caller' : esc(entry.actor);
  return renderShell({ state, csrf, active: 'audit', title: `${code} - ${actionLabels[entry.action] ?? entry.action}`, flash, crumbs: crumbs('audit', code),
    actions: outcomePill(entry),
    body: panel('Entry', props([
      ['Time', stamp(entry.ts)],
      ['Actor', who],
      ['Client', entry.client_id ? clientLink(entry.client_id) : '<span class="muted">None</span>'],
      ['Tender', entry.tender_no ? `<span class="num">${esc(entry.tender_no)}</span>` : '<span class="muted">None</span>'],
      ['Rule', entry.rule_id ? esc(entry.rule_id) : '<span class="muted">None</span>'],
      ['Reason', esc(entry.reason)],
      ['Records', linked.length ? linked.join('<br>') : '<span class="muted">None</span>'],
      ...(s.note ? [['Note', esc(s.note)]] : []), ...(s.decline_reason ? [['Decline reason', esc(s.decline_reason)]] : []),
      ...(s.check_result ? [['GeBIZ check', esc(s.check_result)]] : []),
    ]), '<span class="muted small">Append-only: this entry can never change.</span>') });
}

export function renderTender({ state, dataset, csrf, flash, tenderNo }) {
  const { clientLink } = lookups(state);
  const contract = dataset.contracts.find((c) => c.tender_no === tenderNo);
  const briefs = state.briefs.filter((b) => b.tender_no === tenderNo);
  const conflicts = state.conflicts.filter((c) => c.tender_no === tenderNo);
  const hold = state.holds.find((h) => h.tender_no === tenderNo);
  const outcome = state.backtest.rows?.find((r) => r.prediction.tender_no === tenderNo);
  return renderShell({ state, csrf, active: 'briefs', title: tenderNo, flash,
    sub: contract.is_holdout ? 'A 2026 award replayed to agents as an incoming tender, winner and amount hidden.' : 'A historical award (comparable data).',
    body: `<div class="detail"><div class="stack-gap">
${panel('Briefs', list(briefs.map((b) => `${recordLink('brief', b, b.tender_no)} ${briefChip(b.status)} ${clientLink(b.client_id)}`), 'No briefs for this tender.'))}
${panel('Conflicts', list(conflicts.map((c) => `${recordLink('conflict', c, c.tender_no)} ${conflictChip(c)}`), 'No conflicts.'))}
</div><aside class="stack-gap">
${panel('Tender', props([
    ['Agency', esc(contract.agency)],
    ['Description', esc(contract.description)],
    ['Advice slot', hold ? `${hold.state === 'held' ? chip('Held', 'progress') : chip('Stopped')} ${clientLink(hold.client_id)}` : '<span class="muted">Free</span>'],
    ['Outcome', outcome ? `<span class="num">${money(outcome.prediction.actual_cents)}</span> ${outcome.in_band ? chip('Inside band', 'done') : chip('Outside band', 'danger')}`
      : contract.is_holdout ? '<span class="muted">Not revealed</span>' : '<span class="muted">Historical</span>'],
  ]))}
</aside></div>` });
}
