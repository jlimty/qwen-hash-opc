// Wipes and rebuilds ONLY the tender_desk schema (the admin's Neon Auth sign-in lives elsewhere and is untouched),
// then seeds the demo baseline. Destructive: it refuses to run without --yes-wipe-tender-desk.
import { mkdir, readFile, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import postgres from 'postgres';
import { rebuildTenderDesk } from '../src/governance-db.mjs';
import { createTenderDesk } from '../src/governance.mjs';
import { connectPg, createPgDatabase } from '../src/pg-database.mjs';
import { parseTenderCsv } from '../src/tender-data.mjs';
import { exists, loadAdminToken, seedDemo, siteConnector } from './lib/seed.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hostOf = (url) => /@([^/:?]+)/.exec(url)?.[1] ?? 'unknown host';
let database;
try {
  const { values } = parseArgs({ options: { 'db-file': { type: 'string' }, 'state-dir': { type: 'string' }, 'yes-wipe-tender-desk': { type: 'boolean' } },
    allowPositionals: false, strict: true });
  if (!values['yes-wipe-tender-desk']) {
    throw new Error('This permanently deletes every Tender Desk client, brief, conflict and audit row. Re-run with --yes-wipe-tender-desk if that is what you want.');
  }
  const dbFile = resolve(values['db-file'] ?? join(homedir(), '.td-db-url'));
  const databaseUrl = (await readFile(dbFile, 'utf8').catch(() => { throw new Error(`Could not read the database URL file ${dbFile}.`); })).trim();
  if (!/^postgres(ql)?:\/\//.test(databaseUrl)) throw new Error('The database URL file must contain a postgres:// connection string.');
  database = createPgDatabase(connectPg(postgres, databaseUrl, { max: 1 }));

  const present = (await database.query("SELECT to_regclass('tender_desk.clients') IS NOT NULL AS present")).rows[0].present;
  const counts = present ? (await database.query(`SELECT (SELECT count(*)::int FROM tender_desk.clients) AS clients,
    (SELECT count(*)::int FROM tender_desk.briefs) AS briefs, (SELECT count(*)::int FROM tender_desk.audit_log) AS audit`)).rows[0] : null;
  console.log(`Target: ${hostOf(databaseUrl)}. Wiping tender_desk${counts ? ` (${counts.clients} clients, ${counts.briefs} briefs, ${counts.audit} audit rows)` : ' (not present)'}.`);

  // Files and config are prepared first. The drop and both migrations then run as one transaction; only the
  // seed runs after it, so the worst failure leaves an empty new schema, and re-running the reseed recovers.
  const stateDir = resolve(values['state-dir'] ?? join(root, '.local', 'site'));
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const adminToken = await loadAdminToken(join(stateDir, 'admin-token.txt'));
  const dataset = parseTenderCsv(await readFile(join(root, 'data', 'GovernmentProcurementviaGeBIZ.csv'), 'utf8'));
  const connector = await siteConnector(root);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (const name of ['agent-tokens', 'connectors']) {
    if (await exists(join(stateDir, name))) await rename(join(stateDir, name), join(stateDir, `${name}.before-reseed-${stamp}`));
  }

  await rebuildTenderDesk(database);
  const desk = createTenderDesk({ database, dataset, adminToken });
  await seedDemo(desk.admin(adminToken), join(stateDir, 'agent-tokens'), { connector, connectorDir: join(stateDir, 'connectors') });
  console.log('Rebuilt tender_desk and seeded the demo baseline (Birch Events, fictional; one public intake connector).');
  console.log(`New credential files: ${join(stateDir, 'agent-tokens')}. QwenWork configs: ${join(stateDir, 'connectors')}. Re-paste Birch's connector in QwenWork.`);
} catch (error) {
  console.error(`Reseed failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await database?.close().catch(() => {});
}
