// Applies any pending tender_desk migrations IN PLACE. Never drops anything: existing clients, briefs and the audit
// log stay. --check only reports what would run. The client count is compared before and after as a guard.
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import postgres from 'postgres';
import { initializeGovernance, pendingMigrations } from '../src/governance-db.mjs';
import { connectPg, createPgDatabase } from '../src/pg-database.mjs';

let database;
try {
  const { values } = parseArgs({ options: { 'db-file': { type: 'string' }, check: { type: 'boolean' } }, allowPositionals: false, strict: true });
  if (!values['db-file']) throw new Error('Pass --db-file <path to a file holding the postgres:// URL>.');
  const databaseUrl = (await readFile(values['db-file'], 'utf8')).trim();
  if (!/^postgres(ql)?:\/\//.test(databaseUrl)) throw new Error('The database URL file must contain a postgres:// connection string.');
  console.log(`Target host: ${new URL(databaseUrl).hostname}`);
  database = createPgDatabase(connectPg(postgres, databaseUrl, { max: 1 }));
  const exists = (await database.query("SELECT to_regclass('tender_desk.clients') IS NOT NULL AS present")).rows[0].present;
  const pending = exists ? await pendingMigrations(database) : ['(fresh database: every migration)'];
  console.log(`Pending: ${pending.length ? pending.join(', ') : 'none'}`);
  if (!values.check && pending.length) {
    const count = async () => (exists || (await database.query("SELECT to_regclass('tender_desk.clients') IS NOT NULL AS p")).rows[0].p
      ? (await database.query('SELECT count(*)::int AS n FROM tender_desk.clients')).rows[0].n : 0);
    const before = exists ? await count() : 0;
    await initializeGovernance(database);
    const after = await count();
    console.log(`Clients before: ${before}, after: ${after}`);
    if (after !== before) throw new Error('The client count changed during migration. Investigate before continuing.');
    console.log('Migrations applied in place.');
  } else if (values.check) {
    console.log('Check only. Nothing was changed.');
  }
} catch (error) {
  console.error(`Migration failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await database?.close().catch(() => {});
}
