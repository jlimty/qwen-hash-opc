import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import postgres from 'postgres';
import { createTenderDesk } from '../src/governance.mjs';
import { createMcpWebHandler } from '../src/mcp-web.mjs';
import { connectPg, createPgDatabase } from '../src/pg-database.mjs';
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
  const [birch, intake] = await Promise.all([token('birch'), token('intake')]);

  const dataset = parseTenderCsv(await readFile(join(root, 'data', 'GovernmentProcurementviaGeBIZ.csv'), 'utf8'));
  database = createPgDatabase(connectPg(postgres, databaseUrl, { max: 1 }));
  const capability = randomBytes(32).toString('hex');
  const desk = createTenderDesk({ database, dataset, adminToken: capability });
  const admin = desk.admin(capability);
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
  const consoleState = async () => admin.readConsole();
  const demoTender = 'DST000ETT26000005';
  const state = {};

  await step('1 intake: Cedar signs up and gets its own connector; projects start unverified', async () => {
    const names = (await rpc(intake, 'tools/list', {})).result.tools.map((t) => t.name);
    ok(!names.includes('request_pricing') && !names.includes('submit_brief'), 'intake sees client tools');
    const created = await tool(intake, 'create_client', { name: 'Cedar Markets (rehearsal)', capabilities: 'Night markets, community events and festivals.',
      categories: ['events-community'], team_size: 6, max_contract_cents: 50000000,
      past_projects: [{ title: 'Harbour night market', value_cents: 9000000 }, { title: 'Charity gala (self-reported)' }] });
    ok(created.outcome === 'allowed' && created.projects.every((p) => p.verified === false), JSON.stringify(created).slice(0, 200));
    state.cedar = created.connector_config.mcpServers[created.connector_name].headers.Authorization.replace(/^Bearer /, '');
    state.market = created.projects.find((p) => /night market/i.test(p.title));
    state.gala = created.projects.find((p) => /gala/i.test(p.title));
    const context = await tool(state.cedar, 'get_client_context');
    ok(context.client.name === 'Cedar Markets (rehearsal)', 'connector not bound to Cedar');
    return `${created.client_reference}, connector "${created.connector_name}" works`;
  });

  await step('2 admin verifies one project on evidence: no note is refused, a note is accepted', async () => {
    const bare = await admin.verifyProject({ project_id: state.market.id, verified: true });
    ok(bare.outcome === 'blocked' && bare.rule_id === 'G3', JSON.stringify(bare));
    const noted = await admin.verifyProject({ project_id: state.market.id, verified: true, note: 'Rehearsal: saw the signed contract.' });
    ok(noted.outcome === 'allowed' && noted.check_result === 'no_match', JSON.stringify(noted));
    return `${noted.project_reference} verified with a note (GeBIZ: ${noted.check_result}); the gala stays unverified`;
  });

  await step('3 scout (Cedar): incoming tenders show no winners or amounts; shortlist saved', async () => {
    const incoming = await tool(state.cedar, 'get_incoming_tenders', { category: 'events-community', limit: 100 });
    ok(incoming.items.length > 0 && !leaks(incoming), 'no tenders, or outcome data leaked');
    const saved = await tool(state.cedar, 'save_shortlist', { items: [{ tender_no: demoTender, fit_score: 85, reasons: ['Event management; matches night markets and festivals'] }] });
    ok(saved.outcome === 'allowed', JSON.stringify(saved));
    return `${incoming.total} incoming; shortlisted ${demoTender}`;
  });

  await step('4 analyst (Cedar): band for the demo tender, no supplier data, no hold taken', async () => {
    const pricing = await tool(state.cedar, 'request_pricing', { tender_no: demoTender, query: 'event management' });
    ok(pricing.outcome === 'allowed' && !leaks(pricing), JSON.stringify(pricing).slice(0, 200));
    state.pricing = pricing;
    ok(!(await consoleState()).holds.some((h) => h.tender_no === demoTender), 'pricing took a hold');
    return `band ${money(pricing.price_band.low_cents)} to ${money(pricing.price_band.high_cents)}, ${pricing.n} comparables`;
  });

  const submit = (bearer, pricing, overrides) => tool(bearer, 'submit_brief', { tender_no: demoTender, stat_id: pricing.stat_id, price_band: pricing.price_band,
    recommendation: 'bid', content: `Recommend bidding. Historical band ${money(pricing.price_band.low_cents)} to ${money(pricing.price_band.high_cents)}; confirm staffing and scope first.`, credentials_cited: [], ...overrides });

  await step('5 guardrails on Cedar\'s brief: G3 unverified citation, G4 altered band, G1 naming a client and a spoofed id', async () => {
    const g3 = await submit(state.cedar, state.pricing, { credentials_cited: [state.gala.id] });
    ok(g3.outcome === 'blocked' && g3.rule_id === 'G3', JSON.stringify(g3));
    const g4 = await submit(state.cedar, state.pricing, { price_band: { ...state.pricing.price_band, high_cents: state.pricing.price_band.high_cents + 100 } });
    ok(g4.rule_id === 'G4', JSON.stringify(g4));
    const g1 = await submit(state.cedar, state.pricing, { content: 'We can undercut Birch Events (demo) on this one.' });
    ok(g1.rule_id === 'G1', JSON.stringify(g1));
    const spoof = await tool(state.cedar, 'get_client_context', { client_id: '00000000-0000-4000-8000-000000000000' });
    ok(spoof.rule_id === 'G1', JSON.stringify(spoof));
    ok(!(await consoleState()).holds.some((h) => h.tender_no === demoTender), 'a blocked brief took the advice slot');
    return 'all blocked; no advice slot taken';
  });

  await step('5b Cedar resubmits citing the verified project: pending approval, Cedar holds the advice slot', async () => {
    const result = await submit(state.cedar, state.pricing, { credentials_cited: [state.market.id] });
    ok(result.outcome === 'allowed' && result.status === 'pending_approval' && !('risk_level' in result), JSON.stringify(result));
    state.briefId = result.brief_id;
    return `${result.brief_reference} pending`;
  });

  await step('6 G2: Birch gets the same public band, but its brief is escalated with nothing disclosed', async () => {
    const pricing = await tool(birch, 'request_pricing', { tender_no: demoTender, query: 'event management' });
    ok(pricing.outcome === 'allowed', JSON.stringify(pricing).slice(0, 200));
    const result = await submit(birch, pricing, {});
    ok(result.outcome === 'escalated' && result.rule_id === 'G2' && !/Cedar|price_band/.test(JSON.stringify(result)), JSON.stringify(result));
    return 'escalated; holder not revealed';
  });

  await step('G5: agents have no way to approve, decline, verify or reveal', async () => {
    const names = (await rpc(state.cedar, 'tools/list', {})).result.tools.map((t) => t.name);
    ok(!names.some((n) => /approve|decline|review|verify|reveal|resolve/.test(n)), `admin-like tools exposed: ${names.join(',')}`);
    return `${names.length} tools, none can decide`;
  });

  await step('7 admin: brief shows risk facts; keeps advising Cedar; approves', async () => {
    const snapshot = await consoleState();
    const brief = snapshot.briefs.find((b) => b.id === state.briefId);
    const conflict = snapshot.conflicts.find((c) => c.status === 'open' && c.tender_no === demoTender);
    ok(brief && conflict, 'brief or conflict missing');
    ok((await admin.resolveConflict({ conflict_id: conflict.id, resolution: 'serve_holder' })).outcome === 'allowed', 'resolve');
    const approved = await admin.reviewBrief({ brief_id: state.briefId, decision: 'approved' });
    ok(approved.outcome === 'approved', JSON.stringify(approved));
    return `${brief.risk_level} risk (${brief.risk_facts.map((f) => f.code).join(', ') || 'no facts'}); conflict resolved; approved`;
  });

  await step('8 Cedar asks "where is my brief?" and gets the approved text; Birch sees it was not advised', async () => {
    const mine = (await tool(state.cedar, 'get_client_context')).client.briefs.find((b) => b.tender_no === demoTender);
    ok(mine?.status === 'approved' && mine.content.includes('Recommend bidding'), JSON.stringify(mine));
    const refused = (await tool(birch, 'get_client_context')).client.advice_refused.find((r) => r.tender_no === demoTender);
    ok(refused?.status === 'not_advised', JSON.stringify(refused));
    return `${mine.reference} approved; Birch: not_advised`;
  });

  await step('9 backtest: revealing the tender shows the real award against the predicted band', async () => {
    const revealed = await admin.revealBacktest({ tender_no: demoTender });
    ok(revealed.outcome === 'allowed', JSON.stringify(revealed));
    const { backtest } = await consoleState();
    const row = backtest.rows.find((r) => r.prediction.tender_no === demoTender);
    ok(row, 'revealed tender missing from the scoreboard');
    const p = row.prediction;
    const inBrief = p.actual_cents >= state.pricing.price_band.low_cents && p.actual_cents <= state.pricing.price_band.high_cents;
    return `actual ${money(p.actual_cents)}: ${inBrief ? 'inside' : 'outside'} the brief's band; ${row.in_band ? 'inside' : 'outside'} the agency-level backtest band`;
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
