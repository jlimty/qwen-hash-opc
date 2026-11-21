import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { initializeGovernance } from '../src/governance-db.mjs';
import { createTenderDesk } from '../src/governance.mjs';
import { parseTenderCsv } from '../src/tender-data.mjs';

const dataset = parseTenderCsv('tender_no,tender_description,agency,award_date,tender_detail_status,supplier_name,awarded_amt\n' + [
  ...[1, 2, 3, 4, 5].map((i) => `OLD-${i},Event management,Agency,1/1/2025,Awarded to Suppliers,Past supplier,${i * 100}`),
  'NEW-1,Event management,Agency,1/1/2026,Awarded to Suppliers,Hidden supplier,123456',
  'NEW-2,Event management,Agency,1/1/2026,Awarded to Suppliers,Hidden supplier,123456',
].join('\n'));
const profile = (name) => ({ name, capabilities: 'Events', categories: ['events-community'], team_size: 3, max_contract_cents: 100000 });

test('pricing, pending briefs, credential bindings and audit survive a database restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tender-desk-workflow-'));
  const founderToken = randomBytes(32).toString('hex');
  let db;
  try {
    db = await PGlite.create(directory);
    await initializeGovernance(db);
    let desk = createTenderDesk({ database: db, dataset, founderToken });
    let founder = desk.founder(founderToken);
    const a = await founder.createClient(profile('Persistent Amber'));
    const b = await founder.createClient(profile('Persistent Birch'));
    const keyA = await founder.issueAgentCredential({ role: 'client', client_id: a.client_id });
    const keyB = await founder.issueAgentCredential({ role: 'client', client_id: b.client_id });
    const agent = await desk.agent(keyA.token);
    const pricing = await agent.invoke('request_pricing', { tender_no: 'NEW-1' });
    assert.equal(pricing.outcome, 'allowed');
    const pending = await agent.invoke('submit_brief', { tender_no: 'NEW-1', stat_id: pricing.stat_id,
      price_band: pricing.price_band, recommendation: 'bid', content: 'Subject to capacity review.' });
    assert.equal(pending.status, 'pending_approval');
    const originalAudit = (await db.query('SELECT * FROM tender_desk.audit_log ORDER BY id')).rows;
    assert.ok(originalAudit.length >= 6);
    await db.close();
    db = undefined;

    db = await PGlite.create(directory);
    await initializeGovernance(db);
    desk = createTenderDesk({ database: db, dataset, founderToken });
    founder = desk.founder(founderToken);
    assert.deepEqual((await db.query('SELECT * FROM tender_desk.audit_log ORDER BY id')).rows, originalAudit);
    const recoveredA = await desk.agent(keyA.token);
    const recoveredB = await desk.agent(keyB.token);
    assert.equal((await recoveredA.invoke('request_pricing', { tender_no: 'NEW-1' })).stat_id, pricing.stat_id);
    assert.equal((await recoveredB.invoke('request_pricing', { tender_no: 'NEW-1' })).outcome, 'escalated');
    assert.equal((await founder.reviewBrief({ brief_id: pending.brief_id, decision: 'approved' })).outcome, 'approved');

    const failingDatabase = {
      transaction: (handler) => db.transaction((tx) => handler({
        query: (sql, params) => {
          if (sql.startsWith('INSERT INTO tender_desk.audit_log') && params[1] === 'request_pricing') throw new Error('Simulated audit write failure');
          return tx.query(sql, params);
        },
      })),
    };
    const failingDesk = createTenderDesk({ database: failingDatabase, dataset, founderToken });
    const failingAgent = await failingDesk.agent(keyA.token);
    const countBefore = (await db.query('SELECT count(*) AS n FROM tender_desk.audit_log')).rows[0].n;
    await assert.rejects(failingAgent.invoke('request_pricing', { tender_no: 'NEW-2' }), /Simulated audit write failure/);
    assert.equal((await db.query("SELECT * FROM tender_desk.pricing_holds WHERE tender_no='NEW-2'")).rows.length, 0);
    assert.equal((await db.query("SELECT * FROM tender_desk.stats_snapshots WHERE tender_no='NEW-2'")).rows.length, 0);
    assert.equal((await db.query('SELECT count(*) AS n FROM tender_desk.audit_log')).rows[0].n, countBefore);
    assert.equal((await recoveredB.invoke('request_pricing', { tender_no: 'NEW-2' })).outcome, 'allowed');
  } finally {
    if (db) await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a tool that throws still leaves an audit row and no partial state', async () => {
  const db = await PGlite.create();
  try {
    await initializeGovernance(db);
    const founderToken = randomBytes(32).toString('hex');
    const founder = createTenderDesk({ database: db, dataset, founderToken }).founder(founderToken);
    const client = await founder.createClient(profile('Throwing Amber'));
    const key = await founder.issueAgentCredential({ role: 'client', client_id: client.client_id });
    const failing = { transaction: (handler) => db.transaction((tx) => handler({ query: (sql, params) => {
      if (sql.startsWith('INSERT INTO tender_desk.pricing_holds')) throw new Error('Simulated database failure');
      return tx.query(sql, params);
    } })) };
    const agent = await createTenderDesk({ database: failing, dataset, founderToken }).agent(key.token);
    await assert.rejects(agent.invoke('request_pricing', { tender_no: 'NEW-1' }), /Simulated database failure/);
    assert.equal((await db.query('SELECT * FROM tender_desk.pricing_holds')).rows.length, 0);
    const rows = (await db.query("SELECT outcome,rule_id,reason FROM tender_desk.audit_log WHERE action='request_pricing'")).rows;
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].outcome, rows[0].rule_id], ['blocked', 'ERROR']);
    assert.doesNotMatch(rows[0].reason, /Simulated|database failure/);
  } finally { await db.close(); }
});
