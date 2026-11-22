// Revokes every customer ('client') and intake connector key, through the admin's audited revoke path. Customers now
// use the web app; the connector endpoint serves only the admin's operator role. --check only counts.
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import postgres from 'postgres';
import { createTenderDesk } from '../src/governance.mjs';
import { connectPg, createPgDatabase } from '../src/pg-database.mjs';
import { parseTenderCsv } from '../src/tender-data.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let database;
try {
  const { values } = parseArgs({ options: { 'db-file': { type: 'string' }, check: { type: 'boolean' } }, allowPositionals: false, strict: true });
  if (!values['db-file']) throw new Error('Pass --db-file <path to a file holding the postgres:// URL>.');
  const databaseUrl = (await readFile(values['db-file'], 'utf8')).trim();
  console.log(`Target host: ${new URL(databaseUrl).hostname}`);
  database = createPgDatabase(connectPg(postgres, databaseUrl, { max: 1 }));
  const legacy = (await database.query("SELECT id,role FROM tender_desk.agent_credentials WHERE role IN ('client','intake') ORDER BY created_at")).rows;
  const count = (role) => legacy.filter((row) => row.role === role).length;
  console.log(`Legacy keys found: client: ${count('client')}, intake: ${count('intake')}`);
  if (!values.check) {
    const dataset = parseTenderCsv(await readFile(join(root, 'data', 'GovernmentProcurementviaGeBIZ.csv'), 'utf8'));
    const token = randomBytes(32).toString('hex');
    const admin = createTenderDesk({ database, dataset, adminToken: token }).admin(token);
    let revoked = 0;
    for (const row of legacy) if ((await admin.revokeAgentCredential({ credential_id: row.id })).outcome === 'allowed') revoked++;
    console.log(`Revoked ${revoked} of ${legacy.length}.`);
  } else console.log('Check only. Nothing was changed.');
} catch (error) {
  console.error(`Revoke failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await database?.close().catch(() => {});
}
