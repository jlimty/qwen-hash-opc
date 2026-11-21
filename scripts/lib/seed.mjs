import { randomBytes } from 'node:crypto';
import { access, chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const exists = (path) => access(path).then(() => true, () => false);
export const seedClients = [
  { label: 'amber', profile: { name: 'Amber Events (demo)', capabilities: 'Community events, festivals and logistics for public-sector clients.',
    categories: ['events-community'], team_size: 8, max_contract_cents: 50000000,
    past_projects: [{ title: 'Neighbourhood festival production', value_cents: 15000000 }, { title: 'Overseas roadshow (self-reported)', value_cents: 8000000 }] }, verifyFirstOnly: true },
  { label: 'birch', profile: { name: 'Birch Events (demo)', capabilities: 'Corporate events, conferences and exhibitions.',
    categories: ['events-community'], team_size: 5, max_contract_cents: 30000000,
    past_projects: [{ title: 'Industry conference series', value_cents: 12000000 }] }, verifyFirstOnly: true },
];

export async function loadFounderToken(path) {
  if (!await exists(path)) await writeFile(path, `${randomBytes(32).toString('hex')}\n`, { flag: 'wx', mode: 0o600 });
  const token = (await readFile(path, 'utf8')).trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('The founder secret file is not a 64-character hexadecimal secret.');
  return token;
}

export async function writeCredential(path, token) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  await writeFile(path, `Bearer ${token}\n`, { flag: 'wx', mode: 0o600 });
}

export async function seedDemo(founder, tokenDir) {
  const intakePath = join(tokenDir, 'intake.txt');
  for (const path of [intakePath, ...seedClients.map(({ label }) => join(tokenDir, `${label}.txt`))]) {
    if (await exists(path)) throw new Error('Demo credentials already exist; remove the agent-tokens directory and database together to reseed.');
  }
  await writeCredential(intakePath, (await founder.issueAgentCredential({ role: 'intake' })).token);
  for (const { label, profile, verifyFirstOnly } of seedClients) {
    const created = await founder.createClient(profile);
    if (created.outcome !== 'allowed') throw new Error(`Could not create demo client ${label}.`);
    if (verifyFirstOnly) await founder.verifyProject({ project_id: created.projects[0].id, verified: true, note: 'Seeded demo client (fictional).' });
    const credential = await founder.issueAgentCredential({ role: 'client', client_id: created.client_id });
    await writeCredential(join(tokenDir, `${label}.txt`), credential.token);
  }
}

