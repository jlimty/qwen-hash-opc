import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { connectorConfig, connectorSlug } from './connector-config.mjs';
import { referenceCode } from './references.mjs';
import { tenderCategories } from './tender-data.mjs';
import { getIncomingTenders, historicalFilterSchema, searchHistoricalTenders } from './tender-catalog.mjs';
import { buildStatsSnapshot } from './tender-stats.mjs';

const text = (max) => z.string().max(max).trim().min(1).refine((value) => !value.includes('\u0000'), 'NUL characters are not allowed.');
const cents = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const tenderNumber = text(100);
const pagination = { limit: z.number().int().min(1).max(100).default(20), offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0) };
const bandSchema = z.strictObject({ low_cents: cents, median_cents: cents, high_cents: cents });
const blocked = (rule_id, reason) => ({ outcome: 'blocked', rule_id, reason });

export const clientProfileSchema = z.strictObject({
  name: text(150), capabilities: text(4000), categories: z.array(z.enum(tenderCategories)).min(1).max(8),
  team_size: z.number().int().min(1).max(100000), max_contract_cents: cents,
  past_projects: z.array(z.strictObject({ title: text(250), agency: text(250).optional(), value_cents: cents.optional(),
    gebiz_tender_no: text(100).optional() })).max(30).default([]),
});

export async function createClient(tx, input) {
  const { rows } = await tx.query(`INSERT INTO tender_desk.clients (name, capabilities, categories, team_size, max_contract_cents)
    VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id, reference_number`,
  [input.name, input.capabilities, input.categories, input.team_size, input.max_contract_cents]);
  if (!rows.length) return blocked('G1', 'That company name is not available. If this is your company, contact Tender Desk.');
  const client_id = rows[0].id;
  const projects = [];
  for (const item of input.past_projects) {
    const result = await tx.query(`INSERT INTO tender_desk.projects (client_id,title,agency,value_cents,verified,gebiz_tender_no)
      VALUES ($1,$2,$3,$4,false,$5) RETURNING id,title,verified`, [client_id, item.title, item.agency ?? null, item.value_cents ?? null, item.gebiz_tender_no ?? null]);
    projects.push(result.rows[0]);
  }
  return { outcome: 'allowed', client_id, client_reference: referenceCode('CLI', rows[0].reference_number), projects };
}

export async function insertAgentCredential(tx, role, clientId = null) {
  const token = randomBytes(32).toString('hex');
  const { rows } = await tx.query(`INSERT INTO tender_desk.agent_credentials (token_hash,role,client_id)
    VALUES ($1,$2,$3) RETURNING id`, [createHash('sha256').update(token).digest('hex'), role, clientId]);
  return { credential_id: rows[0].id, token };
}

// Intake: create the client and hand back its own connector, shown to the caller once.
export async function createClientWithConnector(tx, input, connector) {
  const created = await createClient(tx, input);
  if (created.outcome !== 'allowed') return created;
  const { credential_id, token } = await insertAgentCredential(tx, 'client', created.client_id);
  const connector_name = connectorSlug(input.name);
  return { ...created, credential_id, connector_name,
    connector_config: connectorConfig({ name: connector_name, url: connector.url, origin: connector.origin, timeout: connector.timeout, token }) };
}

export const localConnector = Object.freeze({ url: 'http://127.0.0.1:8788/mcp', origin: 'http://127.0.0.1:8788', timeout: 60 });

export async function hasVerifiedCitations(tx, client_id, ids) {
  const { rows } = await tx.query(`SELECT id FROM tender_desk.projects
    WHERE client_id=$1 AND id=ANY($2::uuid[]) AND verified=true FOR SHARE`, [client_id, ids]);
  return rows.length === new Set(ids).size;
}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// G1: true when the text names another client by its full name as whole words.
export function namesOtherClient(content, names) {
  const text = String(content).normalize('NFKC').toLowerCase();
  return names.some((name) => {
    const needle = String(name).normalize('NFKC').toLowerCase().trim();
    return needle !== '' && new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(needle)}(?![\\p{L}\\p{N}])`, 'u').test(text);
  });
}

export function agentWorkflows(dataset, { connector = localConnector } = {}) {
  const incoming = new Map(dataset.contracts.filter((contract) => contract.is_holdout).map((contract) => [contract.tender_no, contract]));
  return {
    get_policies: {
      description: "List the six Tender Desk governance rules in plain English. Use this to explain a blocked or escalated result to the user; do not retry around a block.",
      roles: ['client', 'intake'], schema: z.strictObject({}),
      run: async () => ({ outcome: 'allowed', policies: [
        { rule_id: 'G1', title: 'Client walls', policy: 'Credentials bind each agent to one client. Do not share client context between chats, and never name another client.' },
        { rule_id: 'G2', title: 'Exclusive advice', policy: 'Tender Desk advises only one client per tender. A second client is escalated to the admin; advice already given is never transferred.' },
        { rule_id: 'G3', title: 'Verified credentials', policy: 'Cited project IDs must belong to this client and be admin-verified. Prose still needs human review.' },
        { rule_id: 'G4', title: 'Grounded numbers', policy: 'Structured price bands must match a saved client/tender snapshot. Prose numbers are checked against the band and shown to the admin, not semantically validated.' },
        { rule_id: 'G5', title: 'Admin approval', policy: 'Agents submit pending briefs. Only the admin can approve or decline them.' },
        { rule_id: 'G6', title: 'Backtest integrity', policy: 'Agent tools never return held-out winners or amounts. Incoming entries are historical backtests, not live tenders.' },
      ] }),
    },
    create_client: { description: "Intake only. Record a new SME client profile after the user confirms it. Every self-reported past project is saved as unverified; only the admin can verify projects. Returns connector_config: the client's personal QwenWork connector. Show it to the user once, to paste into QwenWork Connectors; it is never shown again.",
      roles: ['intake'], schema: clientProfileSchema, run: (tx, actor, input) => createClientWithConnector(tx, input, connector) },
    get_client_context: {
      description: "Return the profile, admin-verified past projects, saved shortlist, this client's briefs with the admin's decision (approved text, or the decline reason), and tenders where advice was refused, for the client this connector is bound to. Takes no arguments; the client is fixed by the connector credential.",
      roles: ['client'], schema: z.strictObject({}),
      run: async (tx, actor) => {
        const client = (await tx.query(`SELECT id,name,capabilities,categories,team_size,max_contract_cents
          FROM tender_desk.clients WHERE id=$1`, [actor.client_id])).rows[0];
        const projects = (await tx.query(`SELECT id,title,agency,value_cents,verified FROM tender_desk.projects
          WHERE client_id=$1 AND verified=true ORDER BY id`, [actor.client_id])).rows;
        const shortlist = (await tx.query(`SELECT tender_no,fit_score,reasons FROM tender_desk.shortlists
          WHERE client_id=$1 ORDER BY tender_no`, [actor.client_id])).rows;
        const briefs = (await tx.query(`SELECT reference_number,tender_no,recommendation,status,created_at,decided_at,decline_reason,content
          FROM tender_desk.briefs WHERE client_id=$1 ORDER BY created_at DESC, reference_number DESC LIMIT 20`, [actor.client_id])).rows
          .map(({ reference_number, created_at, ...b }) => ({ reference: referenceCode('BRF', reference_number), ...b, submitted_at: created_at }));
        const advice_refused = (await tx.query(`SELECT tender_no,status FROM tender_desk.conflicts WHERE client_id=$1 ORDER BY created_at`, [actor.client_id])).rows
          .map((row) => ({ tender_no: row.tender_no, status: row.status === 'open' ? 'awaiting_admin' : 'not_advised' }));
        return { outcome: 'allowed', client: { ...client, max_contract_cents: Number(client.max_contract_cents),
          past_projects: projects.map((p) => ({ ...p, value_cents: p.value_cents === null ? null : Number(p.value_cents) })), shortlist, briefs, advice_refused } };
      },
    },
    get_incoming_tenders: {
      description: "List incoming backtest tenders (historical awards presented as new) with description and agency only. Winners and amounts are never returned. These are not live tenders.",
      roles: ['client'], schema: z.strictObject({ category: z.enum(tenderCategories).optional(), ...pagination }),
      run: async (tx, actor, input) => ({ outcome: 'allowed', ...getIncomingTenders(dataset, input) }),
    },
    search_tenders: {
      description: "Search historical awarded contracts by description, agency, category and award date. Returns descriptions and agencies only, never prices or suppliers.",
      roles: ['client'],
      schema: z.strictObject({ query: historicalFilterSchema.shape.query, agency: historicalFilterSchema.shape.agency,
        category: historicalFilterSchema.shape.category, from: historicalFilterSchema.shape.from,
        to: historicalFilterSchema.shape.to, ...pagination }).refine((v) => !v.from || !v.to || v.from <= v.to),
      run: async (tx, actor, input) => {
        const result = searchHistoricalTenders(dataset, input);
        return { outcome: 'allowed', total: result.total, limit: result.limit, offset: result.offset,
          items: result.items.map(({ tender_no, description, agency, category, award_date }) => ({ tender_no, description, agency, category, award_date })) };
      },
    },
    save_shortlist: {
      description: "Save a shortlist of incoming tenders for this client, each with a 0-100 fit score and reasons. Only incoming tender numbers are accepted.",
      roles: ['client'], schema: z.strictObject({ items: z.array(z.strictObject({
        tender_no: tenderNumber, fit_score: z.number().int().min(0).max(100), reasons: z.array(text(500)).min(1).max(10),
      })).min(1).max(50) }),
      run: async (tx, actor, input) => {
        if (input.items.some((item) => !incoming.has(item.tender_no))) return blocked('G6', 'Shortlists accept incoming backtest tenders only.');
        for (const item of input.items) {
          await tx.query(`INSERT INTO tender_desk.shortlists (client_id,tender_no,fit_score,reasons) VALUES ($1,$2,$3,$4)
            ON CONFLICT (client_id,tender_no) DO UPDATE SET fit_score=EXCLUDED.fit_score,reasons=EXCLUDED.reasons`,
          [actor.client_id, item.tender_no, item.fit_score, item.reasons]);
        }
        return { outcome: 'allowed', saved: input.items.length };
      },
    },
    request_pricing: {
      description: "Request the historical price band for an incoming tender, computed from public GeBIZ awards and saved as a snapshot. Open to every client; it takes no hold. Needs at least five comparable contracts.",
      roles: ['client'], schema: z.strictObject({ tender_no: tenderNumber, query: historicalFilterSchema.shape.query, same_agency: z.boolean().default(false) }),
      run: async (tx, actor, input) => {
        const tender = incoming.get(input.tender_no);
        if (!tender) return blocked('G6', 'Pricing requests require an incoming backtest tender.');
        const snapshot = buildStatsSnapshot(dataset, { category: tender.category, query: input.query,
          agency: input.same_agency ? tender.agency : undefined });
        if (snapshot.status !== 'ready') {
          return blocked('G4', 'At least five positive historical comparables are required. No price band is available.');
        }
        await tx.query(`INSERT INTO tender_desk.stats_snapshots (client_id,tender_no,stat_id,snapshot)
          VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [actor.client_id, input.tender_no, snapshot.stat_id, JSON.stringify(snapshot)]);
        return { outcome: 'allowed', tender_no: input.tender_no, stat_id: snapshot.stat_id, price_band: snapshot.price_band,
          n: snapshot.n, currency: snapshot.currency, filters: snapshot.filters, method: snapshot.method, limitations: snapshot.limitations };
      },
    },
    submit_brief: {
      description: "Submit a bid or no-bid brief for admin approval. Only after the user confirms. The price band must exactly match the snapshot returned by request_pricing, and cited project IDs must be this client's admin-verified projects. Submitting takes the advice slot for this tender: if Tender Desk already advises another client on it, you are escalated to the admin and nothing is saved. A saved brief is always pending approval.",
      roles: ['client'], schema: z.strictObject({ tender_no: tenderNumber, stat_id: z.string().regex(/^stat_[a-f0-9]{64}$/),
        price_band: bandSchema, recommendation: z.enum(['bid', 'no-bid']), content: text(20000),
        credentials_cited: z.array(z.uuid()).max(30).default([]) }),
      run: async (tx, actor, input) => {
        const saved = (await tx.query(`SELECT snapshot FROM tender_desk.stats_snapshots
          WHERE client_id=$1 AND tender_no=$2 AND stat_id=$3`, [actor.client_id, input.tender_no, input.stat_id])).rows[0];
        if (!saved || Object.keys(input.price_band).some((key) => input.price_band[key] !== saved.snapshot.price_band[key])) {
          return blocked('G4', 'The price band must match a saved snapshot for this client and tender.');
        }
        if (!await hasVerifiedCitations(tx, actor.client_id, input.credentials_cited)) return blocked('G3', 'Every cited project must be verified and belong to this client.');
        const otherNames = (await tx.query('SELECT name FROM tender_desk.clients WHERE id<>$1', [actor.client_id])).rows.map((row) => row.name);
        if (namesOtherClient(input.content, otherNames)) return blocked('G1', 'Brief content must not name another client.');
        // G2 last, so a brief blocked by any other rule never takes the advice slot.
        await tx.query('INSERT INTO tender_desk.pricing_holds (tender_no,client_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [input.tender_no, actor.client_id]);
        const hold = (await tx.query('SELECT * FROM tender_desk.pricing_holds WHERE tender_no=$1 FOR UPDATE', [input.tender_no])).rows[0];
        if (hold.state === 'stopped') return blocked('G2', 'Tender Desk has stopped advising on this tender.');
        if (hold.client_id !== actor.client_id) {
          const { rows } = await tx.query(`INSERT INTO tender_desk.conflicts (tender_no,client_id,holder_client_id) VALUES ($1,$2,$3)
            ON CONFLICT (tender_no,client_id) DO UPDATE SET tender_no=EXCLUDED.tender_no RETURNING id`,
          [input.tender_no, actor.client_id, hold.client_id]);
          return { outcome: 'escalated', rule_id: 'G2', conflict_id: rows[0].id,
            reason: 'Tender Desk already advises another client on this tender. The admin has been notified. No advice can be given to you on it.' };
        }
        const flags = ['human_review_required'];
        if (/\p{N}/u.test(input.content)) flags.push('unverified_numeric_content');
        const { rows } = await tx.query(`INSERT INTO tender_desk.briefs
          (client_id,tender_no,stat_id,recommendation,content,credentials_cited,price_band,flags,status)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending_approval') RETURNING id`,
        [actor.client_id, input.tender_no, input.stat_id, input.recommendation, input.content,
          input.credentials_cited, JSON.stringify(input.price_band), flags]);
        return { outcome: 'allowed', brief_id: rows[0].id, status: 'pending_approval', flags };
      },
    },
  };
}
