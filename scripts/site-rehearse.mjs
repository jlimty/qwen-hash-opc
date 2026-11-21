import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import postgres from 'postgres';
import { createTenderDesk } from '../src/governance.mjs';
import { createMcpWebHandler } from '../src/mcp-web.mjs';
import { connectPg, createPgDatabase } from '../src/pg-database.mjs';
import { buildStatsSnapshot } from '../src/tender-stats.mjs';
import { parseTenderCsv } from '../src/tender-data.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const money = (cents) => `S$${(Number(cents) / 100).toLocaleString('en-SG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const hostOf = (url) => /@([^/:?]+)/.exec(url)?.[1]?.replace(/-pooler/, '');
const results = [];
let database;

try {
  const { values } = parseArgs({ options: { 'db-file': { type: 'string' }, 'tokens-dir': { type: 'string' }, 'yes-this-is-disposable': { type: 'boolean' } }, allowPositionals: false, strict: true });
  if (!values['db-file'] || !values['yes-this-is-disposable']) throw new Error('This writes demo data and cannot be undone. Pass --db-file <url file of a DISPOSABLE database> and --yes-this-is-disposable.');
  const databaseUrl = (await readFile(resolve(values['db-file']), 'utf8')).trim();
  const productionFile = join(root, '.local', 'site', 'db-unpooled.url');
  const production = (await readFile(productionFile, 'utf8').catch(() => '')).trim();
  if (production && hostOf(production) === hostOf(databaseUrl)) throw new Error('Refusing to run: that is the production database.');
  const tokensDir = resolve(values['tokens-dir'] ?? join(root, '.local', 'site', 'agent-tokens'));
  const token = async (name) => (await readFile(join(tokensDir, `${name}.txt`), 'utf8')).trim().replace(/^Bearer /, '');
  const [amber, birch, intake] = await Promise.all([token('amber'), token('birch'), token('intake')]);

  const dataset = parseTenderCsv(await readFile(join(root, 'data', 'GovernmentProcurementviaGeBIZ.csv'), 'utf8'));
  database = createPgDatabase(connectPg(postgres, databaseUrl, { max: 1 }));
  const capability = randomBytes(32).toString('hex');
  const desk = createTenderDesk({ database, dataset, founderToken: capability });
  const admin = desk.founder(capability);
  const handle = createMcpWebHandler({ authenticate: (bearer) => desk.agent(bearer) });

  const rpc = async (bearer, method, params) => (await handle(new Request('https://rehearsal.invalid/mcp', { method: 'POST', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }))).json();
  const tool = async (bearer, name, args = {}) => {
    const body = await rpc(bearer, 'tools/call', { name, arguments: args });
    return body.error ? { protocolError: body.error.message } : JSON.parse(body.result.content[0].text);
  };
  const step = async (name, fn) => {
    const started = performance.now();
    try { const detail = await fn(); results.push(true); console.log(`PASS  ${name} (${Math.round(performance.now() - started)} ms) - ${detail}`); }
    catch (error) { results.push(false); console.log(`FAIL  ${name} - ${String(error.message).slice(0, 220)}`); }
  };
  const ok = (condition, message) => { if (!condition) throw new Error(message); };
  const leaks = (value) => /supplier|awarded_cents|awarded_amt|winner/i.test(JSON.stringify(value));

  const state = { };
  await step('intake agent: records a new client; every self-reported project is saved unverified', async () => {
    const names = (await rpc(intake, 'tools/list', {})).result.tools.map((t) => t.name);
    ok(!names.includes('request_pricing') && !names.includes('submit_brief'), 'intake sees client tools');
    const created = await tool(intake, 'create_client', { name: 'Cedar Events (rehearsal)', capabilities: 'Night markets and charity galas.', categories: ['events-community'], team_size: 6, max_contract_cents: 20000000, past_projects: [{ title: 'Harbour night market', value_cents: 9000000 }, { title: 'Charity gala (self-reported)' }] });
    ok(created.outcome === 'allowed' && created.projects.length === 2 && created.projects.every((p) => p.verified === false), JSON.stringify(created).slice(0, 200));
    return `2 projects, both unverified (${created.projects.map((p) => p.title).join(', ')})`;
  });

  await step('scout agent (Amber): sees incoming backtest tenders with no winners or amounts', async () => {
    const context = await tool(amber, 'get_client_context');
    ok(context.client.name === 'Amber Events (demo)', 'wrong identity');
    state.verified = context.client.past_projects.find((p) => p.verified);
    ok(state.verified, 'Amber has no verified project');
    const incoming = await tool(amber, 'get_incoming_tenders', { category: 'events-community', limit: 100 });
    ok(incoming.items.length > 0 && !leaks(incoming), 'no tenders, or outcome data leaked');
    const usable = incoming.items.find((item) => {
      const words = item.description.toLowerCase().match(/[a-z]{5,}/g) ?? [];
      const query = words.slice(0, 2).join(' ');
      return query && buildStatsSnapshot(dataset, { category: item.category, query }).status === 'ready' && (state.query = query);
    });
    ok(usable, 'no incoming tender has enough comparables');
    state.tender = usable.tender_no;
    state.description = usable.description;
    return `${incoming.total} incoming; chose ${state.tender} with query "${state.query}"`;
  });

  await step('both clients shortlist the same tender', async () => {
    for (const [who, bearer] of [['Amber', amber], ['Birch', birch]]) {
      const saved = await tool(bearer, 'save_shortlist', { items: [{ tender_no: state.tender, fit_score: 80, reasons: [`${who}: category and capability match`] }] });
      ok(saved.outcome === 'allowed', JSON.stringify(saved));
    }
    return 'two shortlists saved';
  });

  await step('analyst (Amber): pricing takes an exclusive hold and returns a band with no supplier data', async () => {
    const pricing = await tool(amber, 'request_pricing', { tender_no: state.tender, query: state.query });
    ok(pricing.outcome === 'allowed' && Number.isInteger(pricing.price_band.low_cents) && !leaks(pricing), JSON.stringify(pricing).slice(0, 200));
    state.pricing = pricing;
    return `band ${money(pricing.price_band.low_cents)} to ${money(pricing.price_band.high_cents)}, ${pricing.n} comparables`;
  });

  await step('G2: the competing client (Birch) is escalated and gets no price and no holder identity', async () => {
    const result = await tool(birch, 'request_pricing', { tender_no: state.tender, query: state.query });
    ok(result.outcome === 'escalated' && result.rule_id === 'G2' && !result.price_band, JSON.stringify(result).slice(0, 200));
    ok(!/Amber/.test(JSON.stringify(result)), 'the holder was named');
    return 'escalated, no price, holder not revealed';
  });

  const consoleState = async () => admin.readConsole();
  const submit = (overrides) => tool(amber, 'submit_brief', { tender_no: state.tender, stat_id: state.pricing.stat_id, price_band: state.pricing.price_band, recommendation: 'bid', content: 'Recommend bidding; confirm staffing and scope first.', credentials_cited: [], ...overrides });

  await step('G3: a brief citing an unverified project is blocked', async () => {
    const snapshot = await consoleState();
    const amberId = snapshot.clients.find((c) => c.name === 'Amber Events (demo)').id;
    state.unverified = snapshot.projects.find((p) => p.client_id === amberId && !p.verified);
    if (!state.unverified) {
      const roadshow = snapshot.projects.find((p) => p.client_id === amberId && /roadshow/i.test(p.title));
      ok(roadshow && (await admin.verifyProject({ project_id: roadshow.id, verified: false })).outcome === 'allowed', 'could not recreate an unverified project');
      state.unverified = { ...roadshow, verified: false };
    }
    const result = await submit({ credentials_cited: [state.unverified.id] });
    ok(result.outcome === 'blocked' && result.rule_id === 'G3', JSON.stringify(result));
    return `blocked: "${state.unverified.title}" is not founder-verified`;
  });

  await step('G4: a brief with an altered price band is blocked', async () => {
    const result = await submit({ price_band: { ...state.pricing.price_band, high_cents: state.pricing.price_band.high_cents + 100 } });
    ok(result.outcome === 'blocked' && result.rule_id === 'G4', JSON.stringify(result));
    return 'blocked: band does not match the saved snapshot';
  });

  await step('G1: a brief naming another client is blocked, and a spoofed client_id is blocked', async () => {
    const named = await submit({ content: 'We can undercut Birch Events (demo) on this one.' });
    ok(named.outcome === 'blocked' && named.rule_id === 'G1', JSON.stringify(named));
    const spoof = await tool(amber, 'get_client_context', { client_id: '00000000-0000-4000-8000-000000000000' });
    ok(spoof.outcome === 'blocked' && spoof.rule_id === 'G1', JSON.stringify(spoof));
    return 'both blocked';
  });

  await step('a valid brief citing a verified project is accepted, as pending approval only', async () => {
    const result = await submit({ credentials_cited: [state.verified.id] });
    ok(result.outcome === 'allowed' && result.status === 'pending_approval', JSON.stringify(result));
    state.briefId = result.brief_id;
    return `pending approval, flags: ${result.flags.join(', ')}`;
  });

  await step('G5: agents have no way to approve, decline, verify or reveal', async () => {
    const names = (await rpc(amber, 'tools/list', {})).result.tools.map((t) => t.name);
    ok(!names.some((n) => /approve|decline|review|verify|reveal|resolve/.test(n)), `founder-like tools exposed: ${names.join(',')}`);
    const attempt = await tool(amber, 'review_brief', { brief_id: state.briefId, decision: 'approved' });
    ok(attempt.protocolError, 'review_brief was callable');
    return `${names.length} tools, none can decide`;
  });

  await step('admin console sees one brief waiting, one open conflict and unverified projects', async () => {
    const snapshot = await consoleState();
    const pending = snapshot.briefs.filter((b) => b.status === 'pending_approval').length;
    const open = snapshot.conflicts.filter((c) => c.status === 'open').length;
    const unverified = snapshot.projects.filter((p) => !p.verified).length;
    ok(pending === 1 && open === 1 && unverified >= 3, `pending ${pending}, open ${open}, unverified ${unverified}`);
    return `${pending} brief, ${open} conflict, ${unverified} projects to verify`;
  });

  await step('admin decides: verifies a project, resolves the conflict for the holder, approves the brief', async () => {
    const snapshot = await consoleState();
    const conflict = snapshot.conflicts.find((c) => c.status === 'open');
    ok((await admin.verifyProject({ project_id: state.unverified.id, verified: true })).outcome === 'allowed', 'verify');
    ok((await admin.resolveConflict({ conflict_id: conflict.id, resolution: 'serve_holder' })).outcome === 'allowed', 'resolve');
    const approved = await admin.reviewBrief({ brief_id: state.briefId, decision: 'approved' });
    ok(approved.outcome === 'approved', JSON.stringify(approved));
    ok((await admin.reviewBrief({ brief_id: state.briefId, decision: 'approved' })).outcome === 'blocked', 'a second approval was allowed');
    return 'verified, resolved, approved; a repeat approval is blocked';
  });

  await step('after resolution Birch still gets no price for the tender', async () => {
    const again = await tool(birch, 'request_pricing', { tender_no: state.tender, query: state.query });
    ok(!again.price_band && ['escalated', 'blocked'].includes(again.outcome), JSON.stringify(again).slice(0, 200));
    return `${again.outcome}, no price`;
  });

  await step('backtest: revealing the tender shows the real award against the predicted band', async () => {
    const revealed = await admin.revealBacktest({ tender_no: state.tender });
    ok(revealed.outcome === 'allowed', JSON.stringify(revealed));
    const { backtest } = await consoleState();
    const row = backtest.rows.find((r) => r.prediction.tender_no === state.tender);
    ok(row, 'revealed tender missing from the scoreboard');
    const p = row.prediction;
    return `predicted ${money(p.band.low_cents)} to ${money(p.band.high_cents)}; actual ${money(p.actual_cents)} (${row.in_band ? 'inside' : 'outside'} band); ${backtest.revealed} of ${backtest.scoreable} revealed`;
  });

  await step('audit log recorded every guardrail: G1, G2, G3 and G4', async () => {
    const { audit } = await consoleState();
    const rules = new Set(audit.filter((row) => ['blocked', 'escalated'].includes(row.outcome)).map((row) => row.rule_id));
    ok(['G1', 'G2', 'G3', 'G4'].every((rule) => rules.has(rule)), `rules seen: ${[...rules].join(',')}`);
    return `${audit.length} entries; guardrails recorded: ${[...rules].sort().join(', ')}`;
  });
} catch (error) {
  console.error(`Rehearsal could not run: ${error.message}`);
  process.exitCode = 1;
} finally {
  await database?.close().catch(() => {});
}
const failed = results.filter((passed) => !passed).length;
if (results.length) console.log(`\n${results.length - failed} of ${results.length} steps passed.`);
if (failed) process.exitCode = 1;
