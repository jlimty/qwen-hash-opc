import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { initializeGovernance } from '../src/governance-db.mjs';
import { createTenderDesk } from '../src/governance.mjs';
import { parseTenderCsv } from '../src/tender-data.mjs';

let database;
try {
  const dataset = parseTenderCsv(await readFile(new URL('../data/GovernmentProcurementviaGeBIZ.csv', import.meta.url), 'utf8'));
  database = await PGlite.create();
  await initializeGovernance(database);
  const founderToken = randomBytes(32).toString('hex');
  const desk = createTenderDesk({ database, dataset, founderToken });
  const founder = desk.founder(founderToken);
  const intakeKey = await founder.issueAgentCredential({ role: 'intake' });
  const intake = await desk.agent(intakeKey.token);
  const steps = [];
  function step(action, result, expected, rule_id) {
    if (result.outcome !== expected || (rule_id && result.rule_id !== rule_id)) throw new Error(`Unexpected outcome at ${action}.`);
    steps.push({ action, outcome: result.outcome, ...(result.rule_id && { rule_id: result.rule_id }), ...(result.status && { status: result.status }) });
    return result;
  }
  const profile = (name) => ({ name, capabilities: 'Community events, logistics and event production.', categories: ['events-community'],
    team_size: 8, max_contract_cents: 50000000, past_projects: [{ title: 'Fictional community festival', value_cents: 15000000 }] });
  const a = step('intake_amber', await intake.invoke('create_client', profile('Amber Events Demo')), 'allowed');
  const b = step('intake_birch', await intake.invoke('create_client', profile('Birch Events Demo')), 'allowed');
  const keyA = await founder.issueAgentCredential({ role: 'client', client_id: a.client_id });
  const keyB = await founder.issueAgentCredential({ role: 'client', client_id: b.client_id });
  const agentA = await desk.agent(keyA.token);
  const agentB = await desk.agent(keyB.token);
  const incoming = await agentA.invoke('get_incoming_tenders', { category: 'events-community', limit: 1 });
  const tender = incoming.items[0];
  if (!tender) throw new Error('No events backtest tender is available.');
  for (const [label, agent] of [['amber', agentA], ['birch', agentB]]) {
    step(`shortlist_${label}`, await agent.invoke('save_shortlist', { items: [{ tender_no: tender.tender_no, fit_score: 75,
      reasons: ['Scripted category match; scope still requires agent assessment.'] }] }), 'allowed');
  }
  const pricing = step('request_amber_pricing', await agentA.invoke('request_pricing', { tender_no: tender.tender_no, query: 'event management' }), 'allowed');
  const birchPricing = step('request_birch_pricing', await agentB.invoke('request_pricing', { tender_no: tender.tender_no, query: 'event management' }), 'allowed');
  const brief = { tender_no: tender.tender_no, stat_id: pricing.stat_id, price_band: pricing.price_band, recommendation: 'bid',
    content: 'Scripted demonstration brief, not a bid recommendation. Check scope, duration and capacity before proceeding.', credentials_cited: [a.projects[0].id] };
  step('unverified_project', await agentA.invoke('submit_brief', brief), 'blocked', 'G3');
  step('forged_statistics', await agentA.invoke('submit_brief', { ...brief, stat_id: `stat_${'0'.repeat(64)}` }), 'blocked', 'G4');
  step('client_impersonation', await agentA.invoke('get_client_context', { client_id: b.client_id }), 'blocked', 'G1');
  step('founder_verifies_project', await founder.verifyProject({ project_id: a.projects[0].id, verified: true, note: 'Seeded demo client (fictional).' }), 'allowed');
  const pending = step('submit_valid_brief', await agentA.invoke('submit_brief', brief), 'allowed');
  const conflict = step('birch_brief_escalated', await agentB.invoke('submit_brief', { ...brief, stat_id: birchPricing.stat_id, price_band: birchPricing.price_band, credentials_cited: [] }), 'escalated', 'G2');
  step('agent_cannot_approve', await agentA.invoke('approve_brief', { brief_id: pending.brief_id }), 'blocked', 'G5');
  step('founder_resolves_conflict', await founder.resolveConflict({ conflict_id: conflict.conflict_id, resolution: 'serve_holder' }), 'allowed');
  step('founder_approves', await founder.reviewBrief({ brief_id: pending.brief_id, decision: 'approved' }), 'approved');
  const state = await founder.readConsole();
  console.log(JSON.stringify({
    purpose: 'Local scripted backend demo with fictional clients; not a QwenWork run or a backtest accuracy result.',
    dataset_id: dataset.dataset_id,
    incoming_tender: tender,
    pricing: { stat_id: pricing.stat_id, n: pricing.n, currency: 'SGD', price_band: pricing.price_band },
    steps,
    final_brief_status: state.briefs.find((item) => item.id === pending.brief_id).status,
    audit: state.audit.toReversed().map(({ action, outcome, rule_id, reason }) => ({ action, outcome, rule_id, reason })),
    limitations: 'Local embedded PostgreSQL only. No hosted database, business MCP endpoint, founder UI or backtest reveal is included.',
  }, null, 2));
} catch (error) {
  console.error(`Governance demo failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (database) await database.close();
}
