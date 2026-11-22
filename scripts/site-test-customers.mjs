// Seeds three fictional test customers (company names end in "(test)") so the customer journey can be tried without
// signing up each time. Each gets a Neon Auth account (open sign-up must be on) and a company profile:
//   aster   - events, every project checked
//   bramble - cleaning, one checked and one unchecked
//   clover  - IT, nothing checked
// Credentials go to <state-dir>/test-customers.json (mode 0600) as each account is made, and are never printed.
// A rerun skips the customers already in that file and finishes the rest; it refuses when all three exist.
import { randomBytes } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import postgres from 'postgres';
import { createCustomerAuth } from '../src/customer-auth.mjs';
import { createTenderDesk } from '../src/governance.mjs';
import { connectPg, createPgDatabase } from '../src/pg-database.mjs';
import { parseTenderCsv } from '../src/tender-data.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const customers = [
  { label: 'aster', check: 'all', profile: { name: 'Aster Events (test)', capabilities: 'Corporate events, community festivals and exhibitions.',
    categories: ['events-community'], team_size: 8, max_contract_cents: 60000000,
    past_projects: [{ title: 'Community festival for a town council', agency: 'Town council', value_cents: 18000000 }, { title: 'Exhibition production for a museum', value_cents: 9500000 }] } },
  { label: 'bramble', check: 'first', profile: { name: 'Bramble Cleaning (test)', capabilities: 'Office and school cleaning, housekeeping and pest control.',
    categories: ['cleaning-facilities'], team_size: 40, max_contract_cents: 150000000,
    past_projects: [{ title: 'School cleaning services', agency: 'Ministry of Education - Schools', value_cents: 42000000 }, { title: 'Office housekeeping for a statutory board' }] } },
  { label: 'clover', check: 'none', profile: { name: 'Clover IT (test)', capabilities: 'Software development and IT support for public agencies.',
    categories: ['ict-services'], team_size: 12, max_contract_cents: 80000000, past_projects: [{ title: 'Booking system for a community club' }] } },
];
const password = () => randomBytes(15).toString('base64url').slice(0, 20);

let database;
try {
  const { values } = parseArgs({ options: { 'db-file': { type: 'string' }, 'auth-url-file': { type: 'string' }, 'state-dir': { type: 'string' } }, allowPositionals: false, strict: true });
  if (!values['db-file'] || !values['auth-url-file']) throw new Error('Pass --db-file and --auth-url-file.');
  const stateDir = resolve(values['state-dir'] ?? join(root, '.local', 'site'));
  const out = join(stateDir, 'test-customers.json');
  const saved = JSON.parse(await readFile(out, 'utf8').catch(() => '[]'));
  if (customers.every(({ label }) => saved.some((entry) => entry.label === label))) throw new Error(`${out} already exists with every test customer; they were seeded before.`);
  const databaseUrl = (await readFile(values['db-file'], 'utf8')).trim();
  const authUrl = (await readFile(values['auth-url-file'], 'utf8')).trim();
  const { origin } = JSON.parse(await readFile(join(root, 'scripts', 'site-assets', 'site.json'), 'utf8'));
  const adminUserId = (await readFile(join(stateDir, 'admin-user-id.txt'), 'utf8').catch(() => 'no-admin-here')).trim();
  database = createPgDatabase(connectPg(postgres, databaseUrl, { max: 1 }));
  const dataset = parseTenderCsv(await readFile(join(root, 'data', 'GovernmentProcurementviaGeBIZ.csv'), 'utf8'));
  const adminToken = randomBytes(32).toString('hex');
  const desk = createTenderDesk({ database, dataset, adminToken });
  const admin = desk.admin(adminToken);
  const auth = createCustomerAuth({ baseUrl: authUrl, origin, adminUserId });
  for (const { label, check, profile } of customers) {
    if (saved.some((entry) => entry.label === label)) continue;
    const email = `test+${label}@tenderdesk.invalid`;
    const secret = password();
    const account = await auth.signUp({ email, password: secret, name: profile.name });
    if (!account.ok) throw new Error(`Sign-up for ${label} was refused: ${account.message}`);
    const created = await desk.registerCustomer(account.userId, profile);
    if (created.outcome !== 'allowed') throw new Error(`Profile for ${label} was refused: ${created.reason}`);
    const toCheck = check === 'all' ? created.projects : check === 'first' ? created.projects.slice(0, 1) : [];
    for (const project of toCheck) await admin.verifyProject({ project_id: project.id, verified: true, note: 'Seeded test customer (fictional).' });
    saved.push({ label, email, password: secret, client_reference: created.client_reference });
    await writeFile(out, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
    await chmod(out, 0o600);
    console.log(`Created ${profile.name} (${created.client_reference}).`);
  }
  console.log(`Sign-in details saved to ${out}.`);
} catch (error) {
  console.error(`Test customers failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await database?.close().catch(() => {});
}
