import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { agentWorkflows, clientProfileSchema, createClient, hasVerifiedCitations, insertAgentCredential, submitBrief } from './governance-agent.mjs';
import { fitFacts, pastedTenderNo, priceCheck } from './price-check.mjs';
import { profileGaps } from './profile-help.mjs';
import { categorize, tenderCategories } from './tender-data.mjs';
import { buildBacktest, summarize } from './backtest.mjs';
import { referenceCode } from './references.mjs';
import { crossCheckProject } from './gebiz-check.mjs';
import { computeRiskFacts } from './brief-risk.mjs';
import { bandPositions, checkDraft } from './brief-drafting.mjs';

const digest = (token) => createHash('sha256').update(token).digest();
const blocked = (rule_id, reason) => ({ outcome: 'blocked', rule_id, reason });

const refusal = "This tender isn't available for a reviewed brief right now.";
const short = (max) => z.string().trim().min(1).max(max).refine((value) => !value.includes('\u0000'), 'NUL characters are not allowed.');
const requestSchema = z.strictObject({
  tender_no: short(100).optional(),
  pasted: z.strictObject({ title: short(300), agency: short(250).optional(), text: z.string().max(4000).optional() }).optional(),
  requirements: z.string().max(4000).optional(),
  terms: z.array(z.string().max(80)).max(3).default([]),
  category: z.enum(tenderCategories).optional(),
}).refine((value) => Boolean(value.tender_no) !== Boolean(value.pasted), 'Give either an open tender or a pasted tender.');
const requestIdSchema = z.strictObject({ request_id: z.uuid() });
const draftInputSchema = z.strictObject({ request_id: z.uuid(), recommendation: z.enum(['bid', 'no-bid']), content: short(20000),
  credentials_cited: z.array(z.uuid()).max(30).default([]), parts: z.record(z.string(), z.unknown()).optional(), risk_text: z.string().max(20000).optional() });
// Credit settings live in tender_desk.settings so the admin can reprice without a deploy.
export async function creditSettings(tx) {
  const rows = Object.fromEntries((await tx.query("SELECT key,value FROM tender_desk.settings WHERE key IN ('credit_price_cents','credits_per_brief','welcome_credits','credit_packs')")).rows.map((r) => [r.key, r.value]));
  // A bad value never mints credits or breaks sign-up: each setting is a whole number in range, or its default.
  const whole = (value, min, max, fallback) => { const n = Number(value); return Number.isInteger(n) && n >= min && n <= max ? n : fallback; };
  const packs = String(rows.credit_packs ?? '').split(',').map((pack) => pack.split(':').map(Number))
    .filter(([credits, cents]) => Number.isInteger(credits) && credits >= 1 && credits <= 1000 && Number.isInteger(cents) && cents >= 1 && cents <= 100000000)
    .map(([credits, cents]) => ({ credits, cents }));
  return { priceCents: whole(rows.credit_price_cents, 1, 100000000, 2900), perBrief: whole(rows.credits_per_brief, 1, 1000, 1),
    welcome: whole(rows.welcome_credits, 0, 1000, 1), packs };
}
export const holdDaysWithoutClosing = 45;
const creditBalance = async (tx, client_id) => Number((await tx.query('SELECT COALESCE(sum(delta),0) AS n FROM tender_desk.credit_ledger WHERE client_id=$1', [client_id])).rows[0].n);
// Give back whatever a request spent (credits, never cash): used when a request is declined or cancelled.
async function refundRequest(tx, request) {
  const spent = -Number((await tx.query("SELECT COALESCE(sum(delta),0) AS n FROM tender_desk.credit_ledger WHERE request_id=$1 AND reason IN ('brief','refund')", [request.id])).rows[0].n);
  if (spent > 0) await tx.query("INSERT INTO tender_desk.credit_ledger (client_id,delta,reason,request_id) VALUES ($1,$2,'refund',$3)", [request.client_id, spent, request.id]);
  return spent;
}

// Release a tender's advice slot when no advice was given to its holder (a declined or cancelled request).
async function releaseHold(tx, tender_no, client_id) {
  const approved = (await tx.query("SELECT 1 FROM tender_desk.briefs WHERE tender_no=$1 AND client_id=$2 AND status='approved' LIMIT 1", [tender_no, client_id])).rows.length;
  if (!approved) await tx.query("DELETE FROM tender_desk.pricing_holds WHERE tender_no=$1 AND client_id=$2 AND state='held'", [tender_no, client_id]);
}
const credentialSchema = z.discriminatedUnion('role', [
  z.strictObject({ role: z.literal('intake') }),
  z.strictObject({ role: z.literal('operator') }),
  z.strictObject({ role: z.literal('client'), client_id: z.uuid() }),
]);
function validate(schema, input) {
  const parsed = schema.safeParse(input);
  if (parsed.success) return { input: parsed.data };
  const keys = parsed.error.issues.filter((issue) => issue.code === 'unrecognized_keys').flatMap((issue) => issue.keys);
  return { denial: blocked(keys.includes('client_id') ? 'G1' : keys.includes('verified') ? 'G3' : 'VALIDATION', 'Input does not match the permitted tool schema.') };
}

// agentRoles: which connector roles may sign in. The live site allows only 'operator' (the admin's own QwenWork);
// the older customer and intake connectors stay available to tests and local tools.
export function createTenderDesk({ database, dataset, adminToken, backtest: precomputed, connector, agentRoles = ['client', 'intake', 'operator'] }) {
  if (typeof adminToken !== 'string' || !/^[a-f0-9]{64}$/.test(adminToken)) throw new Error('A 32-byte hexadecimal admin token is required.');
  const expectedAdmin = digest(adminToken);
  const contractsByNumber = new Map(dataset.contracts.map((contract) => [contract.tender_no, contract]));
  const workflows = { ...agentWorkflows(dataset, connector ? { connector } : {}), ...operatorWorkflows() };
  const tenderNumbers = new Set(dataset.contracts.map((contract) => contract.tender_no));
  const backtest = precomputed ?? buildBacktest(dataset);
  // Dataset tenders, live GeBIZ numbers and PASTED-<hash> ids are kept in the audit log; anything else is dropped.
  const keepTender = (value) => typeof value === 'string' && (tenderNumbers.has(value) || /^[A-Za-z0-9][A-Za-z0-9-]{2,99}$/.test(value));
  const revealSchema = z.union([z.strictObject({ tender_no: z.string().max(100) }), z.strictObject({ all: z.literal(true) })]);
  async function revealedTenders(tx) {
    const { rows } = await tx.query(`SELECT tender_no, summary->>'scope' AS scope FROM tender_desk.audit_log
      WHERE action='reveal_backtest' AND outcome='allowed'`);
    return rows.some((row) => row.scope === 'all') ? new Set(backtest.predictions.keys()) : new Set(rows.map((row) => row.tender_no).filter(Boolean));
  }

  // Everything a draft may use, assembled by code. Verified projects only.
  async function draftFacts(tx, request) {
    const snapshot = (await tx.query('SELECT snapshot FROM tender_desk.stats_snapshots WHERE client_id=$1 AND tender_no=$2 AND stat_id=$3',
      [request.client_id, request.tender_no, request.stat_id])).rows[0]?.snapshot;
    const client = (await tx.query('SELECT id,name,capabilities,categories,team_size,max_contract_cents FROM tender_desk.clients WHERE id=$1', [request.client_id])).rows[0];
    const verifiedProjects = (await tx.query(`SELECT id,title,agency,value_cents FROM tender_desk.projects WHERE client_id=$1 AND verified ORDER BY reference_number`,
      [request.client_id])).rows.map((p) => ({ ...p, value_cents: p.value_cents === null ? null : Number(p.value_cents) }));
    const open = (await tx.query('SELECT category,closes_at FROM tender_desk.open_tenders WHERE tender_no=$1', [request.tender_no])).rows[0];
    const query_used = snapshot?.filters?.query ?? null;
    const tender = { tender_no: request.tender_no, title: request.title, agency: request.agency, closes_at: open?.closes_at ?? null,
      category: snapshot?.filters?.category ?? open?.category ?? null, pasted_text: request.pasted_text };
    const clientFacts = { ...client, max_contract_cents: Number(client.max_contract_cents) };
    return { request, tender, snapshot, query_used, client: clientFacts, verifiedProjects, requirements_text: request.requirements_text ?? null,
      fit: fitFacts({ client: clientFacts, verifiedProjects, tender, check: { status: snapshot?.status, snapshot, query_used } }) };
  }
  // Replace a pending brief's text and parts in place. Citations re-checked, risk facts recomputed. Never approves.
  async function reviseBrief(tx, input) {
    const brief = (await tx.query('SELECT * FROM tender_desk.briefs WHERE id=$1 FOR UPDATE', [input.brief_id])).rows[0];
    if (!brief || brief.status !== 'pending_approval') return blocked('G5', 'Only a pending brief can be revised.');
    if (!await hasVerifiedCitations(tx, brief.client_id, input.credentials_cited)) return blocked('G3', 'Every cited project must be verified and belong to this client.');
    const snapshot = (await tx.query('SELECT snapshot FROM tender_desk.stats_snapshots WHERE client_id=$1 AND tender_no=$2 AND stat_id=$3',
      [brief.client_id, brief.tender_no, brief.stat_id])).rows[0]?.snapshot;
    const counts = (await tx.query(`SELECT (SELECT max_contract_cents FROM tender_desk.clients WHERE id=$1) AS max_contract_cents,
      (SELECT count(*)::int FROM tender_desk.projects WHERE client_id=$1 AND verified) AS verified,
      (SELECT count(*)::int FROM tender_desk.briefs WHERE client_id=$1 AND id<>$2) AS prior`, [brief.client_id, brief.id])).rows[0];
    const risk = computeRiskFacts({ n: Number(snapshot?.n ?? 0), band: brief.price_band, maxContractCents: Number(counts.max_contract_cents),
      content: input.risk_text ?? input.content, citedCount: new Set(input.credentials_cited).size, verifiedProjectCount: counts.verified, priorBriefCount: counts.prior });
    await tx.query(`UPDATE tender_desk.briefs SET recommendation=$1, content=$2, credentials_cited=$3, parts=COALESCE($4,parts), risk_facts=$5, risk_level=$6, revision=revision+1 WHERE id=$7`,
      [input.recommendation, input.content, input.credentials_cited, input.parts ? JSON.stringify(input.parts) : null, JSON.stringify(risk.facts), risk.level, brief.id]);
    return { outcome: 'allowed', brief_id: brief.id, brief_reference: referenceCode('BRF', brief.reference_number), client_id: brief.client_id, tender_no: brief.tender_no };
  }
  async function addNote(tx, author, input) {
    await tx.query('INSERT INTO tender_desk.review_notes (subject,subject_id,author,note,suggested_action,redraft_note) VALUES ($1,$2,$3,$4,$5,$6)',
      [input.subject, input.id, author, input.note, input.suggested_action ?? null, input.redraft_note ?? null]);
  }
  // The admin's QwenWork: it prepares and suggests; it never approves, declines or verifies.
  function operatorWorkflows() {
    const roles = ['operator'];
    const text = (max) => z.string().trim().min(1).max(max);
    return {
      list_queue: { roles, description: 'List the work waiting for the admin: paid requests with no draft yet, and pending briefs, soonest-closing first, with risk level and notes so far. Read only.',
        schema: z.strictObject({}),
        run: async (tx) => {
          const requests = (await tx.query(`SELECT r.id,r.reference_number,r.title,r.agency,r.tender_no,r.created_at,c.name AS client,o.closes_at
            FROM tender_desk.brief_requests r JOIN tender_desk.clients c ON c.id=r.client_id LEFT JOIN tender_desk.open_tenders o ON o.tender_no=r.tender_no
            WHERE r.status='requested' ORDER BY o.closes_at NULLS LAST, r.created_at`)).rows;
          const briefs = (await tx.query(`SELECT b.id,b.reference_number,b.tender_no,b.recommendation,b.risk_level,r.title,c.name AS client,o.closes_at,
              (SELECT count(*)::int FROM tender_desk.review_notes n WHERE n.subject='brief' AND n.subject_id=b.id) AS notes
            FROM tender_desk.briefs b JOIN tender_desk.clients c ON c.id=b.client_id LEFT JOIN tender_desk.brief_requests r ON r.brief_id=b.id
            LEFT JOIN tender_desk.open_tenders o ON o.tender_no=b.tender_no WHERE b.status='pending_approval' ORDER BY o.closes_at NULLS LAST, b.created_at`)).rows;
          return { outcome: 'allowed',
            waiting_requests: requests.map((r) => ({ request_id: r.id, reference: referenceCode('REQ', r.reference_number), title: r.title, agency: r.agency, tender_no: r.tender_no, client: r.client, closes_at: r.closes_at, paid_at: r.created_at })),
            pending_briefs: briefs.map((b) => ({ brief_id: b.id, reference: referenceCode('BRF', b.reference_number), title: b.title, tender_no: b.tender_no, client: b.client,
              recommendation: b.recommendation, risk_level: b.risk_level, closes_at: b.closes_at, notes: b.notes })) };
        } },
      get_review_pack: { roles, description: 'Everything needed to judge one pending brief (brief_id) or one waiting request (request_id): the draft and its parts, risk facts, the tender, the comparable awards with outliers flagged, the client profile and projects, pasted requirements, and earlier notes. Read only.',
        schema: z.strictObject({ brief_id: z.uuid().optional(), request_id: z.uuid().optional() }).refine((v) => Boolean(v.brief_id) !== Boolean(v.request_id), 'Give brief_id or request_id.'),
        run: async (tx, actor, input) => {
          const brief = input.brief_id ? (await tx.query('SELECT * FROM tender_desk.briefs WHERE id=$1', [input.brief_id])).rows[0] : undefined;
          const request = (await tx.query(input.brief_id ? 'SELECT * FROM tender_desk.brief_requests WHERE brief_id=$1' : 'SELECT * FROM tender_desk.brief_requests WHERE id=$1',
            [input.brief_id ?? input.request_id])).rows[0];
          if (!request) return blocked('G5', 'Nothing to review there.');
          const facts = await draftFacts(tx, request);
          const median = Number(facts.snapshot?.price_band?.median_cents ?? 0);
          const comparables = (facts.snapshot?.comparables ?? []).map((c) => ({ c, contract: contractsByNumber.get(c.tender_no) })).filter(({ contract }) => contract)
            .map(({ c, contract }) => ({ tender_no: c.tender_no, description: contract.description, agency: contract.agency, award_date: contract.last_award_date,
              awarded_sgd: Number(c.total_awarded_cents) / 100, far_from_median: Boolean(median && (Number(c.total_awarded_cents) > 5 * median || Number(c.total_awarded_cents) * 5 < median)) }))
            .slice(0, 40);
          const projects = (await tx.query('SELECT id,title,agency,value_cents,verified,gebiz_tender_no FROM tender_desk.projects WHERE client_id=$1 ORDER BY reference_number', [request.client_id])).rows;
          const notes = (await tx.query('SELECT author,note,suggested_action,created_at FROM tender_desk.review_notes WHERE subject_id=ANY($1::uuid[]) ORDER BY created_at',
            [[request.id, ...(brief ? [brief.id] : [])]])).rows;
          const profile_gaps = profileGaps({ client: facts.client, projects, terms: facts.query_used ? [facts.query_used] : [] });
          return { outcome: 'allowed', tender: facts.tender, requirements_text: facts.requirements_text, profile_gaps,
            band: facts.snapshot?.price_band ?? null, n: facts.snapshot?.n ?? 0, search_terms: facts.query_used, comparables,
            client: { ...facts.client, verified_projects: facts.verifiedProjects, all_projects: projects },
            ...(brief && { brief: { brief_id: brief.id, status: brief.status, recommendation: brief.recommendation, content: brief.content, parts: brief.parts, risk_level: brief.risk_level, risk_facts: brief.risk_facts } }),
            notes };
        } },
      add_review_note: { roles, description: 'Leave a short note for the admin on a brief, a request or a project, with a suggested action. The admin decides; this changes nothing else.',
        schema: z.strictObject({ subject: z.enum(['brief', 'request', 'project']), id: z.uuid(), note: text(2000),
          suggested_action: z.enum(['approve', 'redraft', 'ask_for_more', 'decline', 'verify', 'do_not_verify']).optional(), redraft_note: text(1000).optional() }),
        run: async (tx, actor, input) => {
          const table = { brief: 'briefs', request: 'brief_requests', project: 'projects' }[input.subject];
          const found = (await tx.query(`SELECT client_id FROM tender_desk.${table} WHERE id=$1`, [input.id])).rows[0];
          if (!found) return blocked('VALIDATION', 'That record does not exist.');
          await addNote(tx, actor.name ?? 'operator', input);
          return { outcome: 'allowed', client_id: found.client_id, reason: 'Note saved for the admin.' };
        } },
      propose_revision: { roles, description: 'Rewrite a pending brief. Every server check runs (no invented figures, no IDs, no price talk in reasons, verified citations only) before it replaces the draft. The brief stays pending: only the admin approves.',
        schema: z.strictObject({ brief_id: z.uuid(), recommendation: z.enum(['bid', 'no-bid']), reasons: z.array(text(600)).min(1).max(5),
          price_position: z.strictObject({ band: z.enum(bandPositions), why: text(600) }), questions: z.array(text(300)).max(4).default([]), risks: z.array(text(300)).max(3).default([]) }),
        run: async (tx, actor, input) => {
          const brief = (await tx.query('SELECT * FROM tender_desk.briefs WHERE id=$1', [input.brief_id])).rows[0];
          const request = brief && (await tx.query('SELECT * FROM tender_desk.brief_requests WHERE brief_id=$1', [brief.id])).rows[0];
          if (!brief || !request || brief.status !== 'pending_approval') return blocked('G5', 'Only a pending brief can be revised.');
          const checked = checkDraft({ recommendation: input.recommendation, reasons: input.reasons, price_position: input.price_position,
            requirements: brief.parts?.requirements ?? [], questions: input.questions, risks: input.risks, credentials_cited: brief.credentials_cited }, await draftFacts(tx, request));
          if (!checked.ok) return { ...blocked('G4', checked.reason.replace(/ Try Redraft\.$/, '')), client_id: brief.client_id, tender_no: brief.tender_no };
          const result = await reviseBrief(tx, { brief_id: brief.id, ...checked.draft });
          // A revision never marks itself approvable: the operator adds an approve note separately, after re-reading.
          if (result.outcome === 'allowed') await addNote(tx, actor.name ?? 'operator', { subject: 'brief', id: brief.id, note: 'Revised the draft (all checks passed). Read the new version before approving.' });
          return result;
        } },
      prepare_project_check: { roles, description: "Run the GeBIZ cross-check for a client's project and leave a note with a suggested verdict. Does not verify: the admin does.",
        schema: z.strictObject({ project_id: z.uuid() }),
        run: async (tx, actor, input) => {
          const project = (await tx.query('SELECT p.*, c.name AS client_name FROM tender_desk.projects p JOIN tender_desk.clients c ON c.id=p.client_id WHERE p.id=$1', [input.project_id])).rows[0];
          if (!project) return blocked('VALIDATION', 'That project does not exist.');
          const check = crossCheckProject(dataset, project, project.client_name, new Set());
          // A hold-out tender can't be checked yet, which is not the same as a failed check.
          const suggested = check.result === 'match' ? 'verify' : check.result === 'not_checked' ? undefined : 'do_not_verify';
          await addNote(tx, actor.name ?? 'operator', { subject: 'project', id: project.id, note: `GeBIZ cross-check: ${check.result === 'not_checked' ? "can't check yet" : check.result}. ${(check.lines ?? []).join(' ')}`.slice(0, 2000),
            suggested_action: suggested });
          return { outcome: 'allowed', client_id: project.client_id, check_result: check.result, lines: check.lines ?? [], ...(suggested && { suggested_action: suggested }) };
        } },
    };
  }

  async function record(tx, actor, action, result, input = {}) {
    const tender_no = result.tender_no ?? input.tender_no;
    const summary = {};
    for (const key of ['brief_id', 'conflict_id', 'project_id', 'credential_id', 'stat_id', 'attempts', 'scope', 'revealed_count', 'client_reference', 'brief_reference', 'decline_reason', 'project_reference', 'check_result', 'note', 'request_id', 'request_reference', 'payment_status', 'credits_spent', 'credits_bought', 'amount_cents']) {
      if (result[key]) summary[key] = result[key];
    }
    await tx.query(`INSERT INTO tender_desk.audit_log (actor,action,client_id,tender_no,outcome,rule_id,reason,summary)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [actor.name, action, actor.client_id ?? result.client_id ?? null,
      keepTender(tender_no) ? tender_no : null, result.outcome, result.rule_id ?? null,
      result.reason ?? 'Operation completed.', JSON.stringify(summary)]);
    return result;
  }
  async function credential(tx, tokenHash) {
    return (await tx.query('SELECT id,role,client_id FROM tender_desk.agent_credentials WHERE token_hash=$1 FOR SHARE', [tokenHash])).rows[0];
  }
  const authFailures = { lastWrite: 0, pending: 0 };
  async function authenticationFailed(tx) {
    authFailures.pending++;
    const now = Date.now();
    if (now - authFailures.lastWrite >= 60000) {
      const attempts = authFailures.pending;
      authFailures.pending = 0;
      authFailures.lastWrite = now;
      await record(tx, { name: 'unauthenticated' }, 'authenticate', { ...blocked('G1', 'Invalid or revoked credential.'), attempts });
    }
    return { unauthorized: true };
  }
  async function unauthorized(tx, action) {
    await record(tx, { name: 'unauthenticated' }, action, blocked('G1', 'Invalid or revoked credential.'));
    return { unauthorized: true };
  }
  const adminActor = { name: 'admin' };
  function adminOperation(action, schema, handler) {
    return (input = {}) => database.transaction(async (tx) => {
      const checked = validate(schema, input);
      const result = checked.denial ?? await handler(tx, checked.input);
      return record(tx, adminActor, action, result, checked.input);
    });
  }

  // Whether this client may ask for advice on a tender right now. Never reveals who holds it.
  async function requestable(tx, client_id, tender_no, now) {
    const active = (await tx.query(`SELECT reference_number FROM tender_desk.brief_requests
      WHERE client_id=$1 AND tender_no=$2 AND status IN ('requested','drafted','needs_info')`, [client_id, tender_no])).rows[0];
    if (active) return { ok: false, reason: 'active', request_reference: referenceCode('REQ', active.reference_number) };
    const approved = (await tx.query(`SELECT reference_number FROM tender_desk.brief_requests
      WHERE client_id=$1 AND tender_no=$2 AND status='approved' ORDER BY created_at DESC LIMIT 1`, [client_id, tender_no])).rows[0];
    if (approved) return { ok: false, reason: 'approved', request_reference: referenceCode('REQ', approved.reference_number) };
    const open = (await tx.query('SELECT closes_at FROM tender_desk.open_tenders WHERE tender_no=$1', [tender_no])).rows[0];
    if (open?.closes_at && new Date(open.closes_at) <= now) return { ok: false, reason: 'closed' };
    const hold = (await tx.query('SELECT client_id,state FROM tender_desk.pricing_holds WHERE tender_no=$1 AND (expires_at IS NULL OR expires_at > $2)', [tender_no, now])).rows[0];
    if (hold && (hold.state !== 'held' || hold.client_id !== client_id)) return { ok: false, reason: 'held', message: refusal };
    return { ok: true };
  }
  async function customerClient(tx, userId) {
    return (await tx.query('SELECT client_id FROM tender_desk.customers WHERE user_id=$1', [userId])).rows[0]?.client_id;
  }
  async function requestBrief(tx, client_id, input, now) {
    let tender;
    if (input.tender_no) {
      const row = (await tx.query('SELECT * FROM tender_desk.open_tenders WHERE tender_no=$1', [input.tender_no])).rows[0];
      if (!row) return blocked('VALIDATION', 'That tender is not in the open tender list.');
      tender = { tender_no: row.tender_no, title: row.title, agency: row.agency, category: row.category, source: 'feed', pasted_text: null };
    } else {
      const { title, agency, text } = input.pasted;
      tender = { tender_no: pastedTenderNo({ title, agency }), title, agency: agency ?? null, category: categorize(`${title} ${text ?? ''}`),
        source: 'pasted', pasted_text: text ? text.slice(0, 4000) : null };
    }
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [tender.tender_no]);
    const existing = (await tx.query(`SELECT r.id, r.reference_number FROM tender_desk.brief_requests r
      WHERE r.client_id=$1 AND r.tender_no=$2 AND r.status IN ('requested','drafted','needs_info')`, [client_id, tender.tender_no])).rows[0];
    if (existing) return { outcome: 'allowed', request_id: existing.id, request_reference: referenceCode('REQ', existing.reference_number),
      credits_spent: 0, tender_no: tender.tender_no, reason: 'This request already exists; no second credit was spent.' };
    const allowed = await requestable(tx, client_id, tender.tender_no, now);
    if (allowed.reason === 'closed') return { ...blocked('VALIDATION', 'This tender has closed.'), tender_no: tender.tender_no };
    if (allowed.reason === 'approved') return { ...blocked('G5', 'You already have an approved brief on this tender.'), tender_no: tender.tender_no, request_reference: allowed.request_reference };
    if (!allowed.ok) return { ...blocked('G2', refusal), tender_no: tender.tender_no };
    const check = priceCheck(dataset, { terms: input.terms, category: input.category ?? tender.category });
    if (check.status !== 'ready') return { ...blocked('G4', 'At least five comparable awards are needed for a brief. Try broader terms.'), tender_no: tender.tender_no };
    // Lock the client so two requests at once can't spend the same credit.
    await tx.query('SELECT id FROM tender_desk.clients WHERE id=$1 FOR UPDATE', [client_id]);
    const { perBrief } = await creditSettings(tx);
    if (await creditBalance(tx, client_id) < perBrief) return { ...blocked('CREDITS', `Not enough credits: a reviewed brief needs ${perBrief}. Buy credits to continue.`), tender_no: tender.tender_no };
    await tx.query(`INSERT INTO tender_desk.stats_snapshots (client_id,tender_no,stat_id,snapshot) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [client_id, tender.tender_no, check.snapshot.stat_id, JSON.stringify(check.snapshot)]);
    // An expired hold (its tender closed, or a pasted tender's fixed term ran out) is cleared before a new one is taken.
    await tx.query('DELETE FROM tender_desk.pricing_holds WHERE tender_no=$1 AND expires_at <= $2', [tender.tender_no, now]);
    const closes = (await tx.query('SELECT closes_at FROM tender_desk.open_tenders WHERE tender_no=$1', [tender.tender_no])).rows[0]?.closes_at;
    const expires = closes ? new Date(closes) : new Date(now.getTime() + holdDaysWithoutClosing * 86400000);
    await tx.query('INSERT INTO tender_desk.pricing_holds (tender_no,client_id,expires_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [tender.tender_no, client_id, expires]);
    const hold = (await tx.query('SELECT client_id,state FROM tender_desk.pricing_holds WHERE tender_no=$1 FOR UPDATE', [tender.tender_no])).rows[0];
    if (hold.client_id !== client_id || hold.state !== 'held') return { ...blocked('G2', refusal), tender_no: tender.tender_no };
    const terms = check.query_used ? check.query_used.split(' ') : [];
    const { rows } = await tx.query(`INSERT INTO tender_desk.brief_requests (client_id,tender_no,source,title,agency,pasted_text,terms,stat_id,status,requirements_text)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'requested',$9) RETURNING id, reference_number`,
    [client_id, tender.tender_no, tender.source, tender.title, tender.agency, tender.pasted_text, terms, check.snapshot.stat_id, input.requirements?.trim() || null]);
    await tx.query("INSERT INTO tender_desk.credit_ledger (client_id,delta,reason,request_id) VALUES ($1,$2,'brief',$3)", [client_id, -perBrief, rows[0].id]);
    return { outcome: 'allowed', request_id: rows[0].id, request_reference: referenceCode('REQ', rows[0].reference_number), credits_spent: perBrief,
      tender_no: tender.tender_no, reason: `Brief requested; ${perBrief} credit${perBrief === 1 ? '' : 's'} spent.` };
  }
  async function customerContext(tx, client_id) {
    const client = (await tx.query('SELECT id,name,uen,capabilities,categories,team_size,max_contract_cents,reference_number FROM tender_desk.clients WHERE id=$1', [client_id])).rows[0];
    const projects = (await tx.query(`SELECT id,reference_number,title,agency,value_cents,verified,gebiz_tender_no FROM tender_desk.projects
      WHERE client_id=$1 ORDER BY reference_number`, [client_id])).rows;
    const requests = (await tx.query(`SELECT r.id,r.reference_number,r.tender_no,r.source,r.title,r.agency,r.status,r.created_at,r.decline_reason,r.info_request,r.requirements_text,
        b.recommendation,b.content,b.parts,b.decline_reason AS brief_decline_reason, o.closes_at, o.gebiz_url, s.snapshot->'comparables' AS comparables,
        s.snapshot->'price_band' AS price_band, (s.snapshot->>'n')::int AS n, (s.snapshot->>'wide_band')::boolean AS wide_band, s.snapshot->'filters'->>'query' AS query_used
      FROM tender_desk.brief_requests r LEFT JOIN tender_desk.briefs b ON b.id=r.brief_id
      LEFT JOIN tender_desk.stats_snapshots s ON s.client_id=r.client_id AND s.tender_no=r.tender_no AND s.stat_id=r.stat_id
      LEFT JOIN tender_desk.open_tenders o ON o.tender_no=r.tender_no
      WHERE r.client_id=$1 ORDER BY r.created_at DESC, r.reference_number DESC`, [client_id])).rows;
    return {
      client: { ...client, max_contract_cents: Number(client.max_contract_cents), reference: referenceCode('CLI', client.reference_number) },
      projects: projects.map((p) => ({ ...p, reference: referenceCode('PRJ', p.reference_number), value_cents: p.value_cents === null ? null : Number(p.value_cents) })),
      requests: requests.map((r) => ({ id: r.id, reference: referenceCode('REQ', r.reference_number), tender_no: r.tender_no, source: r.source, title: r.title,
        agency: r.agency, status: r.status, created_at: r.created_at, closes_at: r.closes_at, gebiz_url: r.gebiz_url,
        ...(r.status === 'needs_info' && { info_request: r.info_request, requirements_text: r.requirements_text }),
        ...(r.status === 'approved' && { content: r.content, parts: r.parts, comparables: r.comparables ?? [], recommendation: r.recommendation, price_band: r.price_band, n: r.n, wide_band: r.wide_band, query_used: r.query_used }),
        ...(r.status === 'declined' && { decline_reason: r.decline_reason ?? r.brief_decline_reason }) })),
    };
  }

  return Object.freeze({
    async registerCustomer(userId, profile) {
      return database.transaction(async (tx) => {
        const checked = validate(clientProfileSchema, profile);
        const actor = { name: 'customer:signup' };
        if (checked.denial) return record(tx, actor, 'register_customer', checked.denial);
        if (typeof userId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(userId)) return record(tx, actor, 'register_customer', blocked('G1', 'Sign in again to continue.'));
        // A UEN is required for customers: one company per UEN, so one welcome credit per real business.
        if (!checked.input.uen) return record(tx, actor, 'register_customer', blocked('VALIDATION', "Enter your company's UEN."));
        if (await customerClient(tx, userId)) return record(tx, actor, 'register_customer', blocked('G1', 'This account already has a company profile.'));
        const created = await createClient(tx, checked.input);
        if (created.outcome === 'allowed') {
          await tx.query('INSERT INTO tender_desk.customers (user_id,client_id) VALUES ($1,$2)', [userId, created.client_id]);
          const { welcome } = await creditSettings(tx);
          if (welcome > 0) await tx.query("INSERT INTO tender_desk.credit_ledger (client_id,delta,reason) VALUES ($1,$2,'welcome')", [created.client_id, welcome]);
        }
        return record(tx, created.client_id ? { name: `customer:${created.client_id}`, client_id: created.client_id } : actor, 'register_customer', created);
      });
    },
    async customer(userId) {
      const client_id = typeof userId === 'string' ? await database.transaction((tx) => customerClient(tx, userId)) : undefined;
      if (!client_id) throw new Error('Unauthorized');
      const actor = { name: `customer:${client_id}`, client_id };
      const operation = (action, schema, handler) => (input = {}, options = {}) => database.transaction(async (tx) => {
        if (await customerClient(tx, userId) !== client_id) throw new Error('Unauthorized');
        const checked = validate(schema, input);
        const result = checked.denial ?? await handler(tx, checked.input, options.now ?? new Date());
        return record(tx, actor, action, result, checked.input);
      });
      return Object.freeze({
        client_id,
        context: () => database.transaction((tx) => customerContext(tx, client_id)),
        canRequest: (tender_no, { now = new Date() } = {}) => database.transaction((tx) => requestable(tx, client_id, String(tender_no ?? ''), now)),
        requestBrief: operation('request_brief', requestSchema, (tx, input, now) => requestBrief(tx, client_id, input, now)),
        updateProfile: operation('update_profile', clientProfileSchema.omit({ name: true, uen: true }), async (tx, input) => {
          await tx.query('UPDATE tender_desk.clients SET capabilities=$1, categories=$2, team_size=$3, max_contract_cents=$4 WHERE id=$5',
            [input.capabilities, input.categories, input.team_size, input.max_contract_cents, client_id]);
          for (const item of input.past_projects) {
            await tx.query(`INSERT INTO tender_desk.projects (client_id,title,agency,value_cents,verified,gebiz_tender_no) VALUES ($1,$2,$3,$4,false,$5)`,
              [client_id, item.title, item.agency ?? null, item.value_cents ?? null, item.gebiz_tender_no ?? null]);
          }
          return { outcome: 'allowed', client_id, reason: `Profile updated${input.past_projects.length ? `; ${input.past_projects.length} project(s) added, unverified` : ''}.` };
        }),
        credits: () => database.transaction(async (tx) => {
          const settings = await creditSettings(tx);
          const history = (await tx.query(`SELECT l.delta,l.reason,l.created_at,r.reference_number,r.title FROM tender_desk.credit_ledger l
            LEFT JOIN tender_desk.brief_requests r ON r.id=l.request_id WHERE l.client_id=$1 ORDER BY l.id DESC LIMIT 50`, [client_id])).rows
            .map((h) => ({ delta: h.delta, reason: h.reason, created_at: h.created_at, title: h.title ?? null, reference: h.reference_number ? referenceCode('REQ', h.reference_number) : null }));
          return { balance: await creditBalance(tx, client_id), perBrief: settings.perBrief, priceCents: settings.priceCents, packs: settings.packs, history };
        }),
        buyCredits: operation('buy_credits', z.strictObject({ credits: z.number().int().positive().max(1000) }), async (tx, input) => {
          const pack = (await creditSettings(tx)).packs.find((p) => p.credits === input.credits);
          if (!pack) return blocked('VALIDATION', 'That credit pack is not on offer.');
          const { rows } = await tx.query("INSERT INTO tender_desk.credit_purchases (client_id,credits,amount_cents,status) VALUES ($1,$2,$3,'test') RETURNING id", [client_id, pack.credits, pack.cents]);
          await tx.query("INSERT INTO tender_desk.credit_ledger (client_id,delta,reason,purchase_id) VALUES ($1,$2,'purchase',$3)", [client_id, pack.credits, rows[0].id]);
          return { outcome: 'allowed', credits_bought: pack.credits, amount_cents: pack.cents, reason: `Bought ${pack.credits} credits (test mode).` };
        }),
        // After the admin asked for more: send the request back to the queue, free, optionally with the tender's requirements.
        resubmit: operation('resubmit_request', z.strictObject({ request_id: z.uuid(), requirements: z.string().trim().max(4000).optional() }), async (tx, input) => {
          const request = (await tx.query('SELECT * FROM tender_desk.brief_requests WHERE id=$1 AND client_id=$2 FOR UPDATE', [input.request_id, client_id])).rows[0];
          if (!request || request.status !== 'needs_info') return blocked('G5', 'Only a request we asked you about can be resubmitted.');
          await tx.query(`UPDATE tender_desk.brief_requests SET status='requested', resubmitted_at=now(), updated_at=now(),
            requirements_text=COALESCE($2, requirements_text) WHERE id=$1`, [request.id, input.requirements || null]);
          return { outcome: 'allowed', request_id: request.id, request_reference: referenceCode('REQ', request.reference_number), tender_no: request.tender_no,
            reason: 'Resubmitted; no credit spent.' };
        }),
        cancelRequest: operation('cancel_request', requestIdSchema, async (tx, input) => {
          const request = (await tx.query('SELECT * FROM tender_desk.brief_requests WHERE id=$1 AND client_id=$2 FOR UPDATE', [input.request_id, client_id])).rows[0];
          if (!request || !['requested', 'needs_info'].includes(request.status)) return blocked('G5', 'Only a request that is still waiting can be cancelled.');
          await tx.query("UPDATE tender_desk.brief_requests SET status='cancelled', updated_at=now() WHERE id=$1", [request.id]);
          await releaseHold(tx, request.tender_no, client_id);
          await refundRequest(tx, request);
          return { outcome: 'allowed', request_id: request.id, request_reference: referenceCode('REQ', request.reference_number), tender_no: request.tender_no };
        }),
      });
    },
    async agent(token) {
      const tokenHash = typeof token === 'string' ? digest(token).toString('hex') : '';
      const actor = await database.transaction(async (tx) => {
        const found = await credential(tx, tokenHash);
        if (!found || !agentRoles.includes(found.role)) return authenticationFailed(tx);
        return found;
      });
      if (actor.unauthorized) throw new Error('Unauthorized');
      return Object.freeze({
        toolNames: Object.freeze(Object.keys(workflows).filter((name) => workflows[name].roles.includes(actor.role))),
        tools: Object.freeze(Object.entries(workflows).filter(([, flow]) => flow.roles.includes(actor.role))
          .map(([name, flow]) => Object.freeze({ name, description: flow.description, schema: flow.schema }))),
        async invoke(name, input = {}) {
          const known = typeof name === 'string' && Object.hasOwn(workflows, name);
          const action = known ? name : 'unknown_tool';
          let result;
          try {
            result = await database.transaction(async (tx) => {
              const current = await credential(tx, tokenHash);
              if (!current || !agentRoles.includes(current.role)) return unauthorized(tx, action);
              // The admin's QwenWork acts for the admin, not for the customer whose brief it touches.
              const identity = { name: `${current.role === 'operator' ? 'operator' : 'agent'}:${current.id}`, client_id: current.client_id };
              if (!known || !workflows[name].roles.includes(current.role)) {
                return record(tx, identity, action, blocked('G5', 'This action is not available to this agent.'));
              }
              const checked = validate(workflows[name].schema, input);
              const output = checked.denial ?? await workflows[name].run(tx, current, checked.input);
              return record(tx, identity, action, output, checked.input);
            });
          } catch (error) {
            const identity = { name: `${actor.role === 'operator' ? 'operator' : 'agent'}:${actor.id}`, client_id: actor.client_id };
            await database.transaction((tx) => record(tx, identity, action, { ...blocked('ERROR', 'The tool call failed before completing.') })).catch(() => {});
            throw error;
          }
          if (result.unauthorized) throw new Error('Unauthorized');
          return result;
        },
      });
    },
    admin(token) {
      if (typeof token !== 'string' || !timingSafeEqual(expectedAdmin, digest(token))) throw new Error('Unauthorized');
      return Object.freeze({
        createClient: adminOperation('create_client', clientProfileSchema, createClient),
        issueAgentCredential: adminOperation('issue_agent_credential', credentialSchema, async (tx, input) => {
          if (input.role === 'client' && !(await tx.query('SELECT id FROM tender_desk.clients WHERE id=$1', [input.client_id])).rows.length) {
            return blocked('G1', 'Client does not exist.');
          }
          const { credential_id, token } = await insertAgentCredential(tx, input.role, input.client_id ?? null);
          return { outcome: 'allowed', credential_id, token, role: input.role, client_id: input.client_id ?? null };
        }),
        revokeAgentCredential: adminOperation('revoke_agent_credential', z.strictObject({ credential_id: z.uuid() }), async (tx, input) => {
          const { rows } = await tx.query('DELETE FROM tender_desk.agent_credentials WHERE id=$1 RETURNING client_id', [input.credential_id]);
          return rows.length ? { outcome: 'allowed', credential_id: input.credential_id, client_id: rows[0].client_id }
            : blocked('G1', 'Credential does not exist.');
        }),
        verifyProject: adminOperation('verify_project', z.strictObject({ project_id: z.uuid(), verified: z.boolean(),
          note: z.string().trim().max(500).optional() }), async (tx, input) => {
          const project = (await tx.query(`SELECT p.*, c.name AS client_name FROM tender_desk.projects p
            JOIN tender_desk.clients c ON c.id = p.client_id WHERE p.id=$1 FOR UPDATE OF p`, [input.project_id])).rows[0];
          if (!project) return blocked('G3', 'Project does not exist.');
          const check = crossCheckProject(dataset, project, project.client_name, await revealedTenders(tx));
          const note = input.note || null;
          if (input.verified && check.result !== 'match' && !note) return blocked('G3', 'A note is required to verify a project without a GeBIZ match.');
          await tx.query(`UPDATE tender_desk.projects SET verified=$1, verification_note=COALESCE($2, verification_note),
            verified_at=CASE WHEN $1 THEN now() ELSE NULL END WHERE id=$3`, [input.verified, note, project.id]);
          return { outcome: 'allowed', project_id: project.id, project_reference: referenceCode('PRJ', project.reference_number),
            client_id: project.client_id, verified: input.verified, check_result: check.result, ...(note && { note }) };
        }),
        reviewBrief: adminOperation('review_brief', z.strictObject({ brief_id: z.uuid(), decision: z.enum(['approved', 'declined']),
          reason: z.string().trim().max(500).optional(), revision: z.number().int().positive().optional() }), async (tx, input) => {
          if (input.decision === 'declined' && !input.reason) return blocked('VALIDATION', 'A decline needs a reason.');
          const brief = (await tx.query('SELECT * FROM tender_desk.briefs WHERE id=$1 FOR UPDATE', [input.brief_id])).rows[0];
          if (!brief) return blocked('G5', 'Brief does not exist.');
          const hold = (await tx.query('SELECT * FROM tender_desk.pricing_holds WHERE tender_no=$1 FOR UPDATE', [brief.tender_no])).rows[0];
          if (input.decision === 'approved' && (!hold || hold.state !== 'held' || hold.client_id !== brief.client_id)) {
            return blocked('G2', 'This brief no longer has an active pricing hold.');
          }
          if (brief.status !== 'pending_approval') return blocked('G5', 'Only pending briefs may be reviewed.');
          if (input.revision !== undefined && input.revision !== brief.revision) {
            return blocked('G5', 'This brief changed since you opened it. Read the new version, then decide.');
          }
          if (input.decision === 'approved' && !await hasVerifiedCitations(tx, brief.client_id, brief.credentials_cited)) {
            return blocked('G3', 'A cited project is no longer verified.');
          }
          const decline_reason = input.decision === 'declined' ? input.reason : null;
          await tx.query('UPDATE tender_desk.briefs SET status=$1, decided_at=now(), decline_reason=$2 WHERE id=$3', [input.decision, decline_reason, brief.id]);
          await tx.query('UPDATE tender_desk.brief_requests SET status=$1, decline_reason=$2, updated_at=now() WHERE brief_id=$3', [input.decision, decline_reason, brief.id]);
          // An approved no-bid frees the tender: the client won't bid, so nobody is being advised against.
          if (input.decision === 'approved' && brief.recommendation === 'no-bid') {
            await tx.query("DELETE FROM tender_desk.pricing_holds WHERE tender_no=$1 AND client_id=$2 AND state='held'", [brief.tender_no, brief.client_id]);
          }
          if (input.decision === 'declined') {
            await releaseHold(tx, brief.tender_no, brief.client_id);
            const request = (await tx.query('SELECT id,client_id FROM tender_desk.brief_requests WHERE brief_id=$1', [brief.id])).rows[0];
            if (request) await refundRequest(tx, request);
          }
          return { outcome: input.decision, status: input.decision, brief_id: brief.id, brief_reference: referenceCode('BRF', brief.reference_number),
            client_id: brief.client_id, tender_no: brief.tender_no, ...(decline_reason && { decline_reason }) };
        }),
        resolveConflict: adminOperation('resolve_conflict', z.strictObject({ conflict_id: z.uuid(), resolution: z.enum(['serve_holder', 'serve_neither']) }), async (tx, input) => {
          const conflict = (await tx.query('SELECT * FROM tender_desk.conflicts WHERE id=$1', [input.conflict_id])).rows[0];
          if (!conflict) return blocked('G2', 'Conflict does not exist.');
          const hold = (await tx.query('SELECT * FROM tender_desk.pricing_holds WHERE tender_no=$1 FOR UPDATE', [conflict.tender_no])).rows[0];
          const locked = (await tx.query('SELECT status FROM tender_desk.conflicts WHERE id=$1 FOR UPDATE', [conflict.id])).rows[0];
          if (locked.status !== 'open') return blocked('G2', 'Only open conflicts may be resolved.');
          if (!hold) {
            await tx.query("UPDATE tender_desk.conflicts SET status='resolved',resolution=$1 WHERE id=$2", ['serve_neither', conflict.id]);
            return { outcome: 'allowed', conflict_id: conflict.id, client_id: conflict.client_id, tender_no: conflict.tender_no, resolution: 'serve_neither',
              reason: 'The holder no longer holds this tender, so the conflict was closed.' };
          }
          if (input.resolution === 'serve_holder' && hold.state !== 'held') return blocked('G2', 'Stopped pricing service cannot be reopened.');
          if (input.resolution === 'serve_neither') await tx.query("UPDATE tender_desk.pricing_holds SET state='stopped' WHERE tender_no=$1", [conflict.tender_no]);
          await tx.query("UPDATE tender_desk.conflicts SET status='resolved',resolution=$1 WHERE id=$2", [input.resolution, conflict.id]);
          return { outcome: 'allowed', conflict_id: conflict.id, client_id: conflict.client_id, tender_no: conflict.tender_no, resolution: input.resolution };
        }),
        revealBacktest: adminOperation('reveal_backtest', revealSchema, async (tx, input) => {
          const already = await revealedTenders(tx);
          if (input.all) return { outcome: 'allowed', scope: 'all', revealed_count: backtest.scoreable - already.size, reason: 'Revealed every scoreable backtest outcome.' };
          if (!backtest.predictions.has(input.tender_no)) return blocked('G6', 'Only scoreable backtest tenders can be revealed.');
          return { outcome: 'allowed', scope: 'tender', tender_no: input.tender_no, revealed_count: already.has(input.tender_no) ? 0 : 1,
            reason: 'Revealed one backtest outcome.' };
        }),
        listBriefRequests: ({ now = new Date() } = {}) => database.transaction(async (tx) => (await tx.query(`SELECT r.*, c.name AS client_name,
            c.reference_number AS client_reference_number, p.status AS payment_status, p.amount_cents, o.closes_at,
            (SELECT -COALESCE(sum(l.delta),0) FROM tender_desk.credit_ledger l WHERE l.request_id=r.id AND l.reason='brief')::int AS credits_spent
          FROM tender_desk.brief_requests r JOIN tender_desk.clients c ON c.id=r.client_id
          LEFT JOIN tender_desk.payments p ON p.request_id=r.id LEFT JOIN tender_desk.open_tenders o ON o.tender_no=r.tender_no
          ORDER BY (r.status IN ('requested','drafted','needs_info')) DESC, r.created_at, r.reference_number`)).rows
          .map((row) => ({ ...row, reference: referenceCode('REQ', row.reference_number), client_reference: referenceCode('CLI', row.client_reference_number),
            closed: Boolean(row.closes_at && new Date(row.closes_at) <= now) }))),
        // Read only: everything a draft may use, assembled by code. Verified projects only.
        prepareDraft: (request_id) => database.transaction(async (tx) => {
          if (!z.uuid().safeParse(request_id).success) return undefined;
          const request = (await tx.query('SELECT * FROM tender_desk.brief_requests WHERE id=$1', [request_id])).rows[0];
          return request ? draftFacts(tx, request) : undefined;
        }),
        saveDraft: adminOperation('save_draft', draftInputSchema, async (tx, input) => {
          const request = (await tx.query('SELECT * FROM tender_desk.brief_requests WHERE id=$1 FOR UPDATE', [input.request_id])).rows[0];
          if (!request || request.status !== 'requested') return blocked('G5', 'Only a waiting request can be drafted.');
          const snapshot = (await tx.query('SELECT snapshot FROM tender_desk.stats_snapshots WHERE client_id=$1 AND tender_no=$2 AND stat_id=$3',
            [request.client_id, request.tender_no, request.stat_id])).rows[0]?.snapshot;
          const result = await submitBrief(tx, { client_id: request.client_id }, { tender_no: request.tender_no, stat_id: request.stat_id,
            price_band: snapshot?.price_band ?? {}, recommendation: input.recommendation, content: input.content, credentials_cited: input.credentials_cited,
            ...(input.risk_text && { risk_text: input.risk_text }) });
          if (result.outcome === 'allowed' && input.parts) await tx.query('UPDATE tender_desk.briefs SET parts=$1 WHERE id=$2', [JSON.stringify(input.parts), result.brief_id]);
          const ids = { request_id: request.id, request_reference: referenceCode('REQ', request.reference_number), client_id: request.client_id, tender_no: request.tender_no };
          if (result.outcome !== 'allowed') {
            await tx.query('UPDATE tender_desk.brief_requests SET last_error=$1, updated_at=now() WHERE id=$2', [String(result.reason).slice(0, 1000), request.id]);
            return { ...result, ...ids };
          }
          await tx.query("UPDATE tender_desk.brief_requests SET status='drafted', brief_id=$1, last_error=NULL, updated_at=now() WHERE id=$2", [result.brief_id, request.id]);
          return { ...result, ...ids };
        }),
        // The admin's edit or redraft of a pending brief, in place. Citations are re-checked and risk facts recomputed.
        reviseDraft: adminOperation('revise_draft', z.strictObject({ brief_id: z.uuid(), recommendation: z.enum(['bid', 'no-bid']), content: short(20000),
          credentials_cited: z.array(z.uuid()).max(30).default([]), parts: z.record(z.string(), z.unknown()).optional(), risk_text: z.string().max(20000).optional() }),
        (tx, input) => reviseBrief(tx, input)),
        recordDraftFailure: adminOperation('draft_failed', z.strictObject({ request_id: z.uuid(), reason: short(1000) }), async (tx, input) => {
          const { rows } = await tx.query(`UPDATE tender_desk.brief_requests SET last_error=$1, updated_at=now() WHERE id=$2
            RETURNING id, reference_number, client_id, tender_no`, [input.reason, input.request_id]);
          if (!rows.length) return blocked('G5', 'Request does not exist.');
          return { ...blocked('G4', input.reason), request_id: rows[0].id, request_reference: referenceCode('REQ', rows[0].reference_number),
            client_id: rows[0].client_id, tender_no: rows[0].tender_no };
        }),
        // Ask the client for what is missing instead of declining. Keeps the hold and the credit; a pending draft is set aside.
        askForInfo: adminOperation('ask_for_info', z.strictObject({ request_id: z.uuid(), message: z.string().trim().max(500).optional() }), async (tx, input) => {
          if (!input.message) return blocked('VALIDATION', 'Say what the client should add.');
          const request = (await tx.query('SELECT * FROM tender_desk.brief_requests WHERE id=$1 FOR UPDATE', [input.request_id])).rows[0];
          if (!request || !['requested', 'drafted'].includes(request.status)) return blocked('G5', 'Only a waiting or drafted request can be sent back to the client.');
          if (request.brief_id) {
            await tx.query("UPDATE tender_desk.briefs SET status='declined', decline_reason='Set aside: more information was requested from the client.', decided_at=now() WHERE id=$1 AND status='pending_approval'", [request.brief_id]);
          }
          await tx.query(`UPDATE tender_desk.brief_requests SET status='needs_info', info_request=$1, brief_id=NULL, last_error=NULL, updated_at=now() WHERE id=$2`, [input.message, request.id]);
          return { outcome: 'allowed', request_id: request.id, request_reference: referenceCode('REQ', request.reference_number), client_id: request.client_id,
            tender_no: request.tender_no, note: input.message };
        }),
        declineRequest: adminOperation('decline_request', z.strictObject({ request_id: z.uuid(), reason: z.string().trim().max(500).optional() }), async (tx, input) => {
          if (!input.reason) return blocked('VALIDATION', 'A decline needs a reason.');
          const request = (await tx.query('SELECT * FROM tender_desk.brief_requests WHERE id=$1 FOR UPDATE', [input.request_id])).rows[0];
          if (!request || !['requested', 'needs_info'].includes(request.status)) return blocked('G5', 'Only a waiting request can be declined here; decline a drafted brief from its brief page.');
          await tx.query("UPDATE tender_desk.brief_requests SET status='declined', decline_reason=$1, updated_at=now() WHERE id=$2", [input.reason, request.id]);
          await releaseHold(tx, request.tender_no, request.client_id);
          await refundRequest(tx, request);
          return { outcome: 'declined', request_id: request.id, request_reference: referenceCode('REQ', request.reference_number), client_id: request.client_id,
            tender_no: request.tender_no, decline_reason: input.reason };
        }),
        readConsole: () => database.transaction(async (tx) => {
          const revealed = await revealedTenders(tx);
          const predictions = [...backtest.predictions.values()];
          return {
            backtest: { ...summarize(predictions.filter((p) => revealed.has(p.tender_no)), backtest),
              pending: predictions.filter((p) => !revealed.has(p.tender_no)).map(({ actual_cents, actual_suppliers, ...hidden }) => hidden) },
            clients: (await tx.query('SELECT * FROM tender_desk.clients ORDER BY created_at,id')).rows,
            projects: (await tx.query('SELECT * FROM tender_desk.projects ORDER BY client_id,id')).rows,
            holds: (await tx.query('SELECT * FROM tender_desk.pricing_holds ORDER BY tender_no')).rows,
            // Live tenders are not in the award dataset: the title, agency and closing date come from the request and the feed.
            briefs: (await tx.query(`SELECT b.*, r.id AS request_id, r.title AS tender_title, r.agency AS tender_agency, r.requirements_text, o.closes_at
              FROM tender_desk.briefs b LEFT JOIN tender_desk.brief_requests r ON r.brief_id=b.id LEFT JOIN tender_desk.open_tenders o ON o.tender_no=b.tender_no
              ORDER BY b.created_at,b.id`)).rows,
            conflicts: (await tx.query('SELECT * FROM tender_desk.conflicts ORDER BY created_at,id')).rows,
            requests: (await tx.query('SELECT id,reference_number,status,client_id,tender_no,title,agency,created_at,brief_id FROM tender_desk.brief_requests ORDER BY created_at,id')).rows,
            notes: (await tx.query('SELECT * FROM tender_desk.review_notes ORDER BY created_at DESC LIMIT 500')).rows,
            openTenders: (await tx.query(`SELECT tender_no,title,agency FROM tender_desk.open_tenders WHERE tender_no IN
              (SELECT tender_no FROM tender_desk.briefs UNION SELECT tender_no FROM tender_desk.brief_requests)`)).rows,
            comparables: (await tx.query("SELECT client_id,tender_no,stat_id,(snapshot->>'n')::int AS n FROM tender_desk.stats_snapshots")).rows,
            audit: (await tx.query('SELECT * FROM tender_desk.audit_log ORDER BY id DESC LIMIT 200')).rows,
            credentials: (await tx.query('SELECT id,role,client_id,created_at FROM tender_desk.agent_credentials ORDER BY created_at,id')).rows,
            shortlists: (await tx.query('SELECT client_id,tender_no,fit_score,reasons FROM tender_desk.shortlists ORDER BY fit_score DESC, tender_no')).rows,
            revealed: [...revealed],
          };
        }),
        // Filtered audit rows for the console. Every filter is optional; values are bound, never interpolated.
        readAudit: ({ q, client_id, tender, rule, outcome, limit = 200 } = {}) => database.transaction(async (tx) => {
          const where = [];
          const params = [];
          const bind = (value) => { params.push(value); return `$${params.length}`; };
          if (client_id) where.push(`client_id = ${bind(client_id)}`);
          if (tender) where.push(`tender_no = ${bind(tender)}`);
          if (rule) where.push(`rule_id = ${bind(rule)}`);
          if (outcome) where.push(`outcome = ${bind(outcome)}`);
          if (q) {
            const auditNumber = /^AUD(\d{5,})$/.exec(q)?.[1];
            if (auditNumber) where.push(`id = ${bind(Number(auditNumber))}`);
            else {
              const like = bind(`%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
              where.push(`(action ILIKE ${like} OR reason ILIKE ${like} OR summary::text ILIKE ${like})`);
            }
          }
          const cap = bind(Math.min(Math.max(Number(limit) || 200, 1), 500));
          return (await tx.query(`SELECT * FROM tender_desk.audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
            ORDER BY id DESC LIMIT ${cap}`, params)).rows;
        }),
        // The saved snapshot behind a brief, so the admin can see which awards made the band.
        readSnapshot: ({ client_id, tender_no, stat_id }) => database.transaction(async (tx) => (await tx.query(
          'SELECT snapshot FROM tender_desk.stats_snapshots WHERE client_id=$1 AND tender_no=$2 AND stat_id=$3', [client_id, tender_no, stat_id])).rows[0]?.snapshot),
        readAuditEntry: (id) => database.transaction(async (tx) => (Number.isSafeInteger(id)
          ? (await tx.query('SELECT * FROM tender_desk.audit_log WHERE id=$1', [id])).rows[0] : undefined)),
      });
    },
  });
}
