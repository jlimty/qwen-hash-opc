import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import postgres from 'postgres';
import { initializeGovernance } from '../src/governance-db.mjs';
import { createTenderDesk } from '../src/governance.mjs';
import { connectPg, createPgDatabase } from '../src/pg-database.mjs';
import { parseTenderCsv } from '../src/tender-data.mjs';
import { loadFounderToken, seedDemo, siteConnector } from './lib/seed.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let database;
try {
  const { values } = parseArgs({ options: { 'db-file': { type: 'string' }, 'state-dir': { type: 'string' }, check: { type: 'boolean' } }, allowPositionals: false, strict: true });
  const dbFile = resolve(values['db-file'] ?? join(homedir(), '.td-db-url'));
  const databaseUrl = (await readFile(dbFile, 'utf8').catch(() => { throw new Error(`Could not read the database URL file ${dbFile}.`); })).trim();
  if (!/^postgres(ql)?:\/\//.test(databaseUrl)) throw new Error('The database URL file must contain a postgres:// connection string.');
  database = createPgDatabase(connectPg(postgres, databaseUrl, { max: 1 }));

  if (values.check) {
    const { rows } = await database.query("SELECT split_part(version(), ' ', 2) AS version, current_database() AS name");
    console.log(`Connected to PostgreSQL ${rows[0].version}, database "${rows[0].name}". Nothing was changed.`);
  } else {
    const stateDir = resolve(values['state-dir'] ?? join(root, '.local', 'site'));
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const founderTokenPath = join(stateDir, 'founder-token.txt');
    const founderToken = await loadFounderToken(founderTokenPath);
    await initializeGovernance(database);
    const { rows } = await database.query('SELECT count(*)::int AS n FROM tender_desk.clients');
    if (rows[0].n > 0) throw new Error('The database already has clients; it looks seeded. Nothing was changed.');
    const dataset = parseTenderCsv(await readFile(join(root, 'data', 'GovernmentProcurementviaGeBIZ.csv'), 'utf8'));
    const desk = createTenderDesk({ database, dataset, founderToken });
    const tokenDir = join(stateDir, 'agent-tokens');
    const connectorDir = join(stateDir, 'connectors');
    await seedDemo(desk.founder(founderToken), tokenDir, { connector: await siteConnector(root), connectorDir });
    console.log('Schema migrated and demo clients seeded (fictional).');
    console.log(`Founder secret file: ${founderTokenPath}`);
    console.log(`Connector credential files: ${tokenDir}`);
    console.log(`QwenWork connector configs (paste into Connectors): ${connectorDir}`);
  }
} catch (error) {
  console.error(`Site seed failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await database?.close().catch(() => {});
}
