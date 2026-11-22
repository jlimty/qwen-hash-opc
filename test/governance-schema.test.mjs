import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { initializeGovernance, rebuildTenderDesk } from '../src/governance-db.mjs';

const migrationUrl = new URL('../db/001-governance.sql', import.meta.url);
const missingClient = '00000000-0000-0000-0000-000000000099';
const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

async function insert(database, table, values) {
  const columns = Object.keys(values);
  const { rows } = await database.query(
    `INSERT INTO tender_desk.${table} (${columns.join(', ')})
     VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    Object.values(values),
  );
  return rows[0];
}

function clientValues(name, overrides = {}) {
  return {
    name, capabilities: 'Event delivery', categories: ['events-community'],
    team_size: 3, max_contract_cents: 10000000, ...overrides,
  };
}

function rejectsCode(operation, code) {
  return assert.rejects(operation, { code });
}

test('initializer does not execute DDL when every migration is already applied', async () => {
  let queries = 0;
  await initializeGovernance({
    async query() { queries++; return { rows: [{ present: true }] }; },
    async exec() { assert.fail('Existing databases must not rerun a migration'); },
  });
  assert.equal(queries, 5);
});

test('005 adds credits, the operator role, review notes and brief parts', async () => {
  const database = new PGlite();
  try {
    await initializeGovernance(database);
    const tables = (await database.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='tender_desk'
      AND table_name = ANY($1::text[]) ORDER BY table_name`, [['credit_ledger', 'credit_purchases', 'review_notes']])).rows.map((r) => r.table_name);
    assert.deepEqual(tables, ['credit_ledger', 'credit_purchases', 'review_notes']);
    const settings = Object.fromEntries((await database.query('SELECT key,value FROM tender_desk.settings')).rows.map((r) => [r.key, r.value]));
    assert.equal(settings.credit_price_cents, '2900');
    assert.equal(settings.credits_per_brief, '1');
    assert.equal(settings.welcome_credits, '1');
    assert.equal(settings.credit_packs, '5:11900,20:39900');
    await database.query("INSERT INTO tender_desk.agent_credentials (token_hash,role) VALUES ($1,'operator')", ['a'.repeat(64)]);
    await assert.rejects(database.query("INSERT INTO tender_desk.agent_credentials (token_hash,role) VALUES ($1,'admin')", ['b'.repeat(64)]));
    const columns = (await database.query(`SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='tender_desk'
      AND ((table_name='briefs' AND column_name='parts') OR (table_name='brief_requests' AND column_name='requirements_text'))`)).rows;
    assert.equal(columns.length, 2);
  } finally { await database.close(); }
});

test('003 adds the assistant tables and keeps 001-002 data', async () => {
  const database = new PGlite();
  try {
    await database.exec(await readFile(migrationUrl, 'utf8'));
    await database.exec(await readFile(new URL('../db/002-journey.sql', import.meta.url), 'utf8'));
    await insert(database, 'clients', clientValues('Early Events'));
    await initializeGovernance(database);
    const { rows } = await database.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='tender_desk'
      AND table_name = ANY($1::text[]) ORDER BY table_name`, [['brief_requests', 'customers', 'feed_state', 'open_tenders', 'payments']]);
    assert.deepEqual(rows.map((row) => row.table_name), ['brief_requests', 'customers', 'feed_state', 'open_tenders', 'payments']);
    assert.equal((await database.query('SELECT count(*)::int AS n FROM tender_desk.clients')).rows[0].n, 1);
  } finally { await database.close(); }
});

test('002 backfills reference numbers on rows created before it', async () => {
  const database = new PGlite();
  try {
    await database.exec(await readFile(migrationUrl, 'utf8'));
    await insert(database, 'clients', clientValues('Early Events'));
    await initializeGovernance(database);
    const { rows } = await database.query('SELECT reference_number FROM tender_desk.clients');
    assert.equal(Number(rows[0].reference_number), 1);
  } finally { await database.close(); }
});

describe('PostgreSQL governance schema', () => {
  let database;
  let clientA;
  let clientB;
  let migrationExecutions = 0;

  before(async () => {
    database = new PGlite();
    await initializeGovernance({
      query: (...args) => database.query(...args),
      exec: (...args) => { migrationExecutions++; return database.exec(...args); },
    });
    clientA = await insert(database, 'clients', clientValues('Alpha Events'));
    clientB = await insert(database, 'clients', clientValues('Beta Events'));
  });

  after(async () => { if (database) await database.close(); });

  test('reference numbers increase per table', async () => {
    const { rows } = await database.query('SELECT name, reference_number FROM tender_desk.clients ORDER BY reference_number');
    assert.deepEqual(rows.map((row) => [row.name, Number(row.reference_number)]), [['Alpha Events', 1], ['Beta Events', 2]]);
  });

  test('initializes twice without rerunning DDL or losing data', async () => {
    assert.equal(migrationExecutions, 5);
    await initializeGovernance({
      query: (...args) => database.query(...args),
      exec: () => assert.fail('Second initialization must not execute DDL'),
    });
    const { rows } = await database.query('SELECT id FROM tender_desk.clients ORDER BY name');
    assert.deepEqual(rows.map((row) => row.id), [clientA.id, clientB.id]);
    const sql = await readFile(migrationUrl, 'utf8');
    assert.match(sql.trim(), /^BEGIN;/);
    assert.match(sql.trim(), /COMMIT;$/);
  });

  test('creates exactly the service tables and column types in tender_desk, not public', async () => {
    const expected = {
      clients: 'id:uuid name:text capabilities:text categories:_text team_size:int4 max_contract_cents:int8 created_at:timestamptz reference_number:int8',
      projects: 'id:uuid client_id:uuid title:text agency:text value_cents:int8 verified:bool reference_number:int8 gebiz_tender_no:text verification_note:text verified_at:timestamptz',
      settings: 'key:text value:text updated_at:timestamptz',
      agent_credentials: 'id:uuid token_hash:text role:text client_id:uuid created_at:timestamptz',
      pricing_holds: 'tender_no:text client_id:uuid state:text created_at:timestamptz',
      stats_snapshots: 'client_id:uuid tender_no:text stat_id:text snapshot:jsonb',
      shortlists: 'client_id:uuid tender_no:text fit_score:int4 reasons:_text',
      briefs: 'id:uuid client_id:uuid tender_no:text stat_id:text recommendation:text content:text credentials_cited:_uuid price_band:jsonb flags:_text status:text created_at:timestamptz reference_number:int8 risk_facts:jsonb risk_level:text decided_at:timestamptz decline_reason:text parts:jsonb revision:int4',
      conflicts: 'id:uuid tender_no:text client_id:uuid holder_client_id:uuid status:text resolution:text created_at:timestamptz reference_number:int8',
      audit_log: 'id:int8 ts:timestamptz actor:text action:text client_id:uuid tender_no:text outcome:text rule_id:text reason:text summary:jsonb',
      open_tenders: 'tender_no:text title:text agency:text published_on:date closes_at:timestamptz gebiz_url:text source_feed:text category:text terms:_text first_seen:timestamptz last_seen:timestamptz',
      feed_state: 'id:int4 refreshed_at:timestamptz succeeded_at:timestamptz',
      customers: 'user_id:text client_id:uuid created_at:timestamptz',
      brief_requests: 'id:uuid reference_number:int8 client_id:uuid tender_no:text source:text title:text agency:text pasted_text:text terms:_text stat_id:text status:text brief_id:uuid last_error:text decline_reason:text created_at:timestamptz updated_at:timestamptz requirements_text:text',
      credit_ledger: 'id:int8 client_id:uuid delta:int4 reason:text request_id:uuid purchase_id:uuid created_at:timestamptz',
      credit_purchases: 'id:uuid client_id:uuid credits:int4 amount_cents:int8 currency:text status:text created_at:timestamptz',
      review_notes: 'id:uuid subject:text subject_id:uuid author:text note:text suggested_action:text redraft_note:text created_at:timestamptz',
      payments: 'id:uuid request_id:uuid amount_cents:int8 currency:text status:text created_at:timestamptz',
    };
    const { rows } = await database.query(`
      SELECT table_name, column_name, udt_name FROM information_schema.columns
      WHERE table_schema = 'tender_desk' ORDER BY table_name, ordinal_position
    `);
    const actual = {};
    for (const row of rows) {
      (actual[row.table_name] ??= []).push(`${row.column_name}:${row.udt_name}`);
    }
    assert.deepEqual(Object.fromEntries(Object.entries(actual).map(([table, columns]) =>
      [table, columns.join(' ')])), expected);
    const publicTables = await database.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY($1::text[])
    `, [Object.keys(expected)]);
    assert.deepEqual(publicTables.rows, []);

    const keys = await database.query(`
      SELECT tc.table_name, string_agg(kcu.column_name, ',' ORDER BY kcu.ordinal_position) AS columns
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_schema = kcu.constraint_schema AND tc.constraint_name = kcu.constraint_name
      WHERE tc.table_schema = 'tender_desk' AND tc.constraint_type = 'PRIMARY KEY'
      GROUP BY tc.table_name
    `);
    assert.deepEqual(Object.fromEntries(keys.rows.map((row) => [row.table_name, row.columns])), {
      clients: 'id', projects: 'id', settings: 'key', agent_credentials: 'id', pricing_holds: 'tender_no',
      stats_snapshots: 'client_id,tender_no,stat_id', shortlists: 'client_id,tender_no',
      briefs: 'id', conflicts: 'id', audit_log: 'id',
      open_tenders: 'tender_no', feed_state: 'id', credit_ledger: 'id', credit_purchases: 'id', review_notes: 'id', customers: 'user_id', brief_requests: 'id', payments: 'id',
    });
  });

  test('one active brief request per client and tender', async () => {
    const values = { client_id: clientA.id, tender_no: 'RPO000ETQ26000129', source: 'feed', title: 'Audit services',
      terms: ['audit'], stat_id: `stat_${'a'.repeat(64)}`, status: 'requested' };
    await insert(database, 'brief_requests', values);
    await rejectsCode(insert(database, 'brief_requests', values), '23505');
    await insert(database, 'brief_requests', { ...values, status: 'declined' });
  });

  test('revokes PUBLIC access to its schema, tables, functions, and sequences', async () => {
    const { rows } = await database.query(`
      SELECT n.nspname AS object_name, a.privilege_type
      FROM pg_namespace n, LATERAL aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) a
      WHERE n.nspname = 'tender_desk' AND a.grantee = 0
      UNION ALL
      SELECT c.relname, a.privilege_type
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
        LATERAL aclexplode(COALESCE(c.relacl,
          acldefault(CASE WHEN c.relkind = 'S' THEN 'S'::"char" ELSE 'r'::"char" END, c.relowner))) a
      WHERE n.nspname = 'tender_desk' AND c.relkind IN ('r', 'S') AND a.grantee = 0
      UNION ALL
      SELECT p.proname, a.privilege_type
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace,
        LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
      WHERE n.nspname = 'tender_desk' AND a.grantee = 0
    `);
    assert.deepEqual(rows, []);
  });

  test('validates client names, required categories, team size, and safe cent bounds', async () => {
    assert.match(clientA.id, uuidPattern);
    assert.ok(Number.isFinite(Date.parse(clientA.created_at)));
    for (const name of ['', '   ']) {
      await rejectsCode(() => insert(database, 'clients', clientValues(name)), '23514');
    }
    await rejectsCode(() => insert(database, 'clients', clientValues('ALPHA EVENTS')), '23505');
    await rejectsCode(() => insert(database, 'clients', clientValues('No categories', { categories: null })), '23502');
    for (const team_size of [0, -1]) {
      await rejectsCode(() => insert(database, 'clients', clientValues('Bad team', { team_size })), '23514');
    }
    for (const max_contract_cents of [-1, '9007199254740992']) {
      await rejectsCode(() => insert(database, 'clients', clientValues('Bad ceiling', { max_contract_cents })), '23514');
    }
    for (const max_contract_cents of [0, '9007199254740991']) {
      await insert(database, 'clients', clientValues(`Ceiling ${max_contract_cents}`, { max_contract_cents }));
    }
  });

  test('projects default to unverified and accept only safe nonnegative or null values', async () => {
    const values = { client_id: clientA.id, title: 'Community event' };
    const project = await insert(database, 'projects', values);
    assert.match(project.id, uuidPattern);
    assert.equal(project.verified, false);
    assert.equal(project.agency, null);
    assert.equal(project.value_cents, null);
    for (const value_cents of [0, '9007199254740991']) {
      await insert(database, 'projects', { ...values, value_cents });
    }
    for (const value_cents of [-1, '9007199254740992']) {
      await rejectsCode(() => insert(database, 'projects', { ...values, value_cents }), '23514');
    }
    await rejectsCode(() => insert(database, 'projects', { ...values, client_id: missingClient }), '23503');
  });

  test('binds client credentials to clients and intake credentials to no client', async () => {
    const credential = await insert(database, 'agent_credentials', {
      token_hash: 'a'.repeat(64), role: 'client', client_id: clientA.id,
    });
    assert.match(credential.id, uuidPattern);
    await insert(database, 'agent_credentials', { token_hash: 'b'.repeat(64), role: 'intake' });
    await rejectsCode(() => insert(database, 'agent_credentials', {
      token_hash: 'a'.repeat(64), role: 'intake',
    }), '23505');
    for (const binding of [
      { role: 'client', client_id: null }, { role: 'intake', client_id: clientA.id },
      { role: 'admin', client_id: null },
    ]) {
      await rejectsCode(() => insert(database, 'agent_credentials', { token_hash: 'c'.repeat(64), ...binding }), '23514');
    }
    for (const token_hash of ['A'.repeat(64), 'g'.repeat(64), 'c'.repeat(63), 'c'.repeat(65), '']) {
      await rejectsCode(() => insert(database, 'agent_credentials', { token_hash, role: 'intake' }), '23514');
    }
    await rejectsCode(() => insert(database, 'agent_credentials', {
      token_hash: 'd'.repeat(64), role: 'client', client_id: missingClient,
    }), '23503');
    await rejectsCode(() => insert(database, 'agent_credentials', { token_hash: null, role: 'intake' }), '23502');
    await rejectsCode(() => insert(database, 'agent_credentials', { token_hash: 'e'.repeat(64), role: null }), '23502');
  });

  test('allows exactly one pricing hold per tender, including stopped holds', async () => {
    const hold = await insert(database, 'pricing_holds', { tender_no: 'HOLD-1', client_id: clientA.id });
    assert.equal(hold.state, 'held');
    assert.ok(Number.isFinite(Date.parse(hold.created_at)));
    await rejectsCode(() => insert(database, 'pricing_holds', { tender_no: 'HOLD-1', client_id: clientB.id }), '23505');
    await database.query("UPDATE tender_desk.pricing_holds SET state = 'stopped' WHERE tender_no = 'HOLD-1'");
    await rejectsCode(() => insert(database, 'pricing_holds', { tender_no: 'HOLD-1', client_id: clientB.id }), '23505');
    await rejectsCode(() => insert(database, 'pricing_holds', { tender_no: 'HOLD-2', client_id: clientA.id, state: 'released' }), '23514');
    await rejectsCode(() => insert(database, 'pricing_holds', { tender_no: 'HOLD-2', client_id: missingClient }), '23503');
  });

  test('shortlists enforce client/tender uniqueness and 0..100 fit scores', async () => {
    const values = { client_id: clientA.id, tender_no: 'SHORT-1', fit_score: 0, reasons: ['Category match'] };
    await insert(database, 'shortlists', values);
    await insert(database, 'shortlists', { ...values, client_id: clientB.id, fit_score: 100 });
    await rejectsCode(() => insert(database, 'shortlists', values), '23505');
    for (const fit_score of [-1, 101]) {
      await rejectsCode(() => insert(database, 'shortlists', { ...values, tender_no: 'SHORT-2', fit_score }), '23514');
    }
    await rejectsCode(() => insert(database, 'shortlists', { ...values, client_id: missingClient }), '23503');
  });

  test('briefs reference a snapshot belonging to the same client and tender', async () => {
    const snapshot = { client_id: clientA.id, tender_no: 'BRIEF-1', stat_id: 'stat_original', snapshot: { n: 5 } };
    await insert(database, 'stats_snapshots', snapshot);
    await rejectsCode(() => insert(database, 'stats_snapshots', snapshot), '23505');
    await rejectsCode(() => insert(database, 'stats_snapshots', { ...snapshot, client_id: missingClient }), '23503');
    const values = {
      client_id: clientA.id, tender_no: 'BRIEF-1', stat_id: 'stat_original', recommendation: 'bid',
      content: 'Ready for human review', credentials_cited: [], price_band: { low_cents: 10000 },
      flags: [], status: 'pending_approval',
    };
    const brief = await insert(database, 'briefs', values);
    assert.match(brief.id, uuidPattern);
    assert.ok(Number.isFinite(Date.parse(brief.created_at)));
    for (const overrides of [
      { client_id: clientB.id }, { tender_no: 'OTHER-TENDER' }, { stat_id: 'stat_other' }, { client_id: missingClient },
    ]) {
      await rejectsCode(() => insert(database, 'briefs', { ...values, ...overrides }), '23503');
    }
    for (const overrides of [{ recommendation: 'maybe' }, { status: 'published' }]) {
      await rejectsCode(() => insert(database, 'briefs', { ...values, ...overrides }), '23514');
    }
    for (const status of ['approved', 'declined']) {
      await insert(database, 'briefs', { ...values, recommendation: 'no-bid', status });
    }
  });

  test('conflicts preserve both client references and one request per tender/client', async () => {
    const values = { tender_no: 'CONFLICT-1', client_id: clientA.id, holder_client_id: clientB.id };
    const conflict = await insert(database, 'conflicts', values);
    assert.match(conflict.id, uuidPattern);
    assert.equal(conflict.status, 'open');
    assert.equal(conflict.resolution, null);
    assert.ok(Number.isFinite(Date.parse(conflict.created_at)));
    await rejectsCode(() => insert(database, 'conflicts', values), '23505');
    for (const overrides of [{ client_id: missingClient }, { holder_client_id: missingClient }]) {
      await rejectsCode(() => insert(database, 'conflicts', { ...values, tender_no: 'CONFLICT-2', ...overrides }), '23503');
    }
    await rejectsCode(() => insert(database, 'conflicts', { ...values, tender_no: 'CONFLICT-2', status: 'dismissed' }), '23514');
    await database.query("UPDATE tender_desk.conflicts SET status = 'resolved', resolution = 'Declined request' WHERE id = $1", [conflict.id]);
  });

  test('audit records default their identity, timestamp and summary and constrain outcomes', async () => {
    const values = { actor: 'schema-test', action: 'check', outcome: 'allowed', reason: 'Owner SQL' };
    const record = await insert(database, 'audit_log', values);
    assert.ok(BigInt(record.id) > 0n);
    assert.ok(Number.isFinite(Date.parse(record.ts)));
    assert.deepEqual(record.summary, {});
    assert.equal(record.client_id, null);
    assert.equal(record.tender_no, null);
    assert.equal(record.rule_id, null);
    for (const outcome of ['blocked', 'escalated', 'approved', 'declined']) {
      await insert(database, 'audit_log', { ...values, outcome });
    }
    await rejectsCode(() => insert(database, 'audit_log', { ...values, outcome: 'ignored' }), '23514');
    await rejectsCode(() => insert(database, 'audit_log', { ...values, summary: null }), '23502');
  });

  test('audit and snapshots reject owner UPDATE, DELETE and TRUNCATE without changing records', async () => {
    await insert(database, 'audit_log', {
      actor: 'schema-test', action: 'immutability', outcome: 'allowed', reason: 'Original record',
    });
    await insert(database, 'stats_snapshots', {
      client_id: clientA.id, tender_no: 'IMMUTABLE-1', stat_id: 'stat_immutable', snapshot: { n: 5 },
    });
    const owner = await database.query(`
      SELECT bool_and(pg_get_userbyid(relowner) = current_user) AS owns_tables
      FROM pg_class WHERE oid IN ('tender_desk.audit_log'::regclass, 'tender_desk.stats_snapshots'::regclass)
    `);
    assert.equal(owner.rows[0].owns_tables, true);
    for (const [table, assignment] of [
      ['audit_log', "reason = 'tampered'"], ['stats_snapshots', "snapshot = '{}'::jsonb"],
    ]) {
      const before = (await database.query(`SELECT * FROM tender_desk.${table}`)).rows;
      assert.ok(before.length > 0);
      for (const sql of [
        `UPDATE tender_desk.${table} SET ${assignment}`,
        `DELETE FROM tender_desk.${table}`,
        `TRUNCATE tender_desk.${table} CASCADE`,
        `UPDATE tender_desk.${table} SET ${assignment} WHERE false`,
        `DELETE FROM tender_desk.${table} WHERE false`,
      ]) {
        await assert.rejects(() => database.exec(sql), (error) => {
          assert.equal(error.code, '55000');
          assert.match(error.message, /append-only/i);
          return true;
        });
      }
      assert.deepEqual((await database.query(`SELECT * FROM tender_desk.${table}`)).rows, before);
    }
  });
});

test('disk-backed PGlite retains a client across close/reopen without rerunning DDL', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tender-desk-governance-'));
  let database;
  try {
    database = new PGlite(directory);
    await initializeGovernance(database);
    const client = await insert(database, 'clients', clientValues('Persistent client'));
    await database.close();
    database = undefined;

    database = new PGlite(directory);
    await initializeGovernance({
      query: (...args) => database.query(...args),
      exec: () => assert.fail('Reopening must not rerun DDL'),
    });
    assert.deepEqual((await database.query('SELECT * FROM tender_desk.clients')).rows, [client]);
  } finally {
    if (database) await database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('rebuildTenderDesk drops and migrates in one transaction, so a failure keeps the old schema and data', async () => {
  const database = new PGlite();
  try {
    await initializeGovernance(database);
    await insert(database, 'clients', clientValues('Survivor Events'));
    const failing = { transaction: (work) => database.transaction((tx) => work({ query: (...a) => tx.query(...a),
      exec: (text) => (text.includes('client_ref_seq') ? Promise.reject(new Error('simulated disconnect')) : tx.exec(text)) })) };
    await assert.rejects(rebuildTenderDesk(failing), /simulated disconnect/);
    assert.deepEqual((await database.query('SELECT name FROM tender_desk.clients')).rows.map((r) => r.name), ['Survivor Events']);
    await rebuildTenderDesk(database);
    assert.equal((await database.query('SELECT count(*)::int AS n FROM tender_desk.clients')).rows[0].n, 0);
    assert.equal((await database.query("SELECT to_regclass('tender_desk.briefs') IS NOT NULL AS ok")).rows[0].ok, true);
  } finally { await database.close(); }
});
