import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { agentWorkflows, clientProfileSchema, createClient, hasVerifiedCitations, insertAgentCredential } from './governance-agent.mjs';
import { buildBacktest, summarize } from './backtest.mjs';

const digest = (token) => createHash('sha256').update(token).digest();
const blocked = (rule_id, reason) => ({ outcome: 'blocked', rule_id, reason });
const credentialSchema = z.discriminatedUnion('role', [
  z.strictObject({ role: z.literal('intake') }),
  z.strictObject({ role: z.literal('client'), client_id: z.uuid() }),
]);
function validate(schema, input) {
  const parsed = schema.safeParse(input);
  if (parsed.success) return { input: parsed.data };
  const keys = parsed.error.issues.filter((issue) => issue.code === 'unrecognized_keys').flatMap((issue) => issue.keys);
  return { denial: blocked(keys.includes('client_id') ? 'G1' : keys.includes('verified') ? 'G3' : 'VALIDATION', 'Input does not match the permitted tool schema.') };
}

export function createTenderDesk({ database, dataset, founderToken, backtest: precomputed, connector }) {
  if (typeof founderToken !== 'string' || !/^[a-f0-9]{64}$/.test(founderToken)) throw new Error('A 32-byte hexadecimal founder token is required.');
  const expectedFounder = digest(founderToken);
  const workflows = agentWorkflows(dataset, connector ? { connector } : {});
  const tenderNumbers = new Set(dataset.contracts.map((contract) => contract.tender_no));
  const backtest = precomputed ?? buildBacktest(dataset);
  const revealSchema = z.union([z.strictObject({ tender_no: z.string().max(100) }), z.strictObject({ all: z.literal(true) })]);
  async function revealedTenders(tx) {
    const { rows } = await tx.query(`SELECT tender_no, summary->>'scope' AS scope FROM tender_desk.audit_log
      WHERE action='reveal_backtest' AND outcome='allowed'`);
    return rows.some((row) => row.scope === 'all') ? new Set(backtest.predictions.keys()) : new Set(rows.map((row) => row.tender_no).filter(Boolean));
  }

  async function record(tx, actor, action, result, input = {}) {
    const tender_no = result.tender_no ?? input.tender_no;
    const summary = {};
    for (const key of ['brief_id', 'conflict_id', 'project_id', 'credential_id', 'stat_id', 'attempts', 'scope', 'revealed_count', 'client_reference']) {
      if (result[key]) summary[key] = result[key];
    }
    await tx.query(`INSERT INTO tender_desk.audit_log (actor,action,client_id,tender_no,outcome,rule_id,reason,summary)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [actor.name, action, actor.client_id ?? result.client_id ?? null,
      tenderNumbers.has(tender_no) ? tender_no : null, result.outcome, result.rule_id ?? null,
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
  const founderActor = { name: 'founder' };
  function founderOperation(action, schema, handler) {
    return (input = {}) => database.transaction(async (tx) => {
      const checked = validate(schema, input);
      const result = checked.denial ?? await handler(tx, checked.input);
      return record(tx, founderActor, action, result, checked.input);
    });
  }

  return Object.freeze({
    async agent(token) {
      const tokenHash = typeof token === 'string' ? digest(token).toString('hex') : '';
      const actor = await database.transaction(async (tx) => {
        const found = await credential(tx, tokenHash);
        if (!found) return authenticationFailed(tx);
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
              if (!current) return unauthorized(tx, action);
              const identity = { name: `agent:${current.id}`, client_id: current.client_id };
              if (!known || !workflows[name].roles.includes(current.role)) {
                return record(tx, identity, action, blocked('G5', 'This action is not available to this agent.'));
              }
              const checked = validate(workflows[name].schema, input);
              const output = checked.denial ?? await workflows[name].run(tx, current, checked.input);
              return record(tx, identity, action, output, checked.input);
            });
          } catch (error) {
            const identity = { name: `agent:${actor.id}`, client_id: actor.client_id };
            await database.transaction((tx) => record(tx, identity, action, { ...blocked('ERROR', 'The tool call failed before completing.') })).catch(() => {});
            throw error;
          }
          if (result.unauthorized) throw new Error('Unauthorized');
          return result;
        },
      });
    },
    founder(token) {
      if (typeof token !== 'string' || !timingSafeEqual(expectedFounder, digest(token))) throw new Error('Unauthorized');
      return Object.freeze({
        createClient: founderOperation('create_client', clientProfileSchema, createClient),
        issueAgentCredential: founderOperation('issue_agent_credential', credentialSchema, async (tx, input) => {
          if (input.role === 'client' && !(await tx.query('SELECT id FROM tender_desk.clients WHERE id=$1', [input.client_id])).rows.length) {
            return blocked('G1', 'Client does not exist.');
          }
          const { credential_id, token } = await insertAgentCredential(tx, input.role, input.client_id ?? null);
          return { outcome: 'allowed', credential_id, token, role: input.role, client_id: input.client_id ?? null };
        }),
        revokeAgentCredential: founderOperation('revoke_agent_credential', z.strictObject({ credential_id: z.uuid() }), async (tx, input) => {
          const { rows } = await tx.query('DELETE FROM tender_desk.agent_credentials WHERE id=$1 RETURNING client_id', [input.credential_id]);
          return rows.length ? { outcome: 'allowed', credential_id: input.credential_id, client_id: rows[0].client_id }
            : blocked('G1', 'Credential does not exist.');
        }),
        verifyProject: founderOperation('verify_project', z.strictObject({ project_id: z.uuid(), verified: z.boolean() }), async (tx, input) => {
          const { rows } = await tx.query('UPDATE tender_desk.projects SET verified=$1 WHERE id=$2 RETURNING client_id', [input.verified, input.project_id]);
          return rows.length ? { outcome: 'allowed', project_id: input.project_id, client_id: rows[0].client_id, verified: input.verified }
            : blocked('G3', 'Project does not exist.');
        }),
        reviewBrief: founderOperation('review_brief', z.strictObject({ brief_id: z.uuid(), decision: z.enum(['approved', 'declined']) }), async (tx, input) => {
          const brief = (await tx.query('SELECT * FROM tender_desk.briefs WHERE id=$1 FOR UPDATE', [input.brief_id])).rows[0];
          if (!brief) return blocked('G5', 'Brief does not exist.');
          const hold = (await tx.query('SELECT * FROM tender_desk.pricing_holds WHERE tender_no=$1 FOR UPDATE', [brief.tender_no])).rows[0];
          if (input.decision === 'approved' && (!hold || hold.state !== 'held' || hold.client_id !== brief.client_id)) {
            return blocked('G2', 'This brief no longer has an active pricing hold.');
          }
          if (brief.status !== 'pending_approval') return blocked('G5', 'Only pending briefs may be reviewed.');
          if (input.decision === 'approved' && !await hasVerifiedCitations(tx, brief.client_id, brief.credentials_cited)) {
            return blocked('G3', 'A cited project is no longer verified.');
          }
          await tx.query('UPDATE tender_desk.briefs SET status=$1 WHERE id=$2', [input.decision, brief.id]);
          return { outcome: input.decision, status: input.decision, brief_id: brief.id, client_id: brief.client_id, tender_no: brief.tender_no };
        }),
        resolveConflict: founderOperation('resolve_conflict', z.strictObject({ conflict_id: z.uuid(), resolution: z.enum(['serve_holder', 'serve_neither']) }), async (tx, input) => {
          const conflict = (await tx.query('SELECT * FROM tender_desk.conflicts WHERE id=$1', [input.conflict_id])).rows[0];
          if (!conflict) return blocked('G2', 'Conflict does not exist.');
          const hold = (await tx.query('SELECT * FROM tender_desk.pricing_holds WHERE tender_no=$1 FOR UPDATE', [conflict.tender_no])).rows[0];
          const locked = (await tx.query('SELECT status FROM tender_desk.conflicts WHERE id=$1 FOR UPDATE', [conflict.id])).rows[0];
          if (locked.status !== 'open') return blocked('G2', 'Only open conflicts may be resolved.');
          if (input.resolution === 'serve_holder' && hold.state !== 'held') return blocked('G2', 'Stopped pricing service cannot be reopened.');
          if (input.resolution === 'serve_neither') await tx.query("UPDATE tender_desk.pricing_holds SET state='stopped' WHERE tender_no=$1", [conflict.tender_no]);
          await tx.query("UPDATE tender_desk.conflicts SET status='resolved',resolution=$1 WHERE id=$2", [input.resolution, conflict.id]);
          return { outcome: 'allowed', conflict_id: conflict.id, client_id: conflict.client_id, tender_no: conflict.tender_no, resolution: input.resolution };
        }),
        revealBacktest: founderOperation('reveal_backtest', revealSchema, async (tx, input) => {
          const already = await revealedTenders(tx);
          if (input.all) return { outcome: 'allowed', scope: 'all', revealed_count: backtest.scoreable - already.size, reason: 'Revealed every scoreable backtest outcome.' };
          if (!backtest.predictions.has(input.tender_no)) return blocked('G6', 'Only scoreable backtest tenders can be revealed.');
          return { outcome: 'allowed', scope: 'tender', tender_no: input.tender_no, revealed_count: already.has(input.tender_no) ? 0 : 1,
            reason: 'Revealed one backtest outcome.' };
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
            briefs: (await tx.query('SELECT * FROM tender_desk.briefs ORDER BY created_at,id')).rows,
            conflicts: (await tx.query('SELECT * FROM tender_desk.conflicts ORDER BY created_at,id')).rows,
            comparables: (await tx.query("SELECT client_id,tender_no,stat_id,(snapshot->>'n')::int AS n FROM tender_desk.stats_snapshots")).rows,
            audit: (await tx.query('SELECT * FROM tender_desk.audit_log ORDER BY id DESC LIMIT 200')).rows,
          };
        }),
      });
    },
  });
}
