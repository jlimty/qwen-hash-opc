import { randomBytes } from 'node:crypto';
import { access, chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { connectorConfig } from '../../src/connector-config.mjs';

export const exists = (path) => access(path).then(() => true, () => false);
// The demo baseline: one seeded competitor. The demo's other client (Cedar Markets) signs up live through intake.
export const seedClients = [
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

async function writeConnector(dir, label, connector, token) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const name = `tender-desk-${label}`;
  await writeFile(join(dir, `${name}.json`), `${JSON.stringify(connectorConfig({ name, ...connector, token }), null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}

// connector: { url, origin, timeout } — when given, paste-ready QwenWork configs are written to connectorDir.
export async function seedDemo(founder, tokenDir, { connector, connectorDir } = {}) {
  const intakePath = join(tokenDir, 'intake.txt');
  for (const path of [intakePath, ...seedClients.map(({ label }) => join(tokenDir, `${label}.txt`))]) {
    if (await exists(path)) throw new Error('Demo credentials already exist; remove the agent-tokens directory and database together to reseed.');
  }
  const intake = (await founder.issueAgentCredential({ role: 'intake' })).token;
  await writeCredential(intakePath, intake);
  if (connector) await writeConnector(connectorDir, 'intake', connector, intake);
  for (const { label, profile, verifyFirstOnly } of seedClients) {
    const created = await founder.createClient(profile);
    if (created.outcome !== 'allowed') throw new Error(`Could not create demo client ${label}.`);
    if (verifyFirstOnly) await founder.verifyProject({ project_id: created.projects[0].id, verified: true, note: 'Seeded demo client (fictional).' });
    const credential = await founder.issueAgentCredential({ role: 'client', client_id: created.client_id });
    await writeCredential(join(tokenDir, `${label}.txt`), credential.token);
    if (connector) await writeConnector(connectorDir, label, connector, credential.token);
  }
}

export async function siteConnector(root) {
  const { origin } = JSON.parse(await readFile(join(root, 'scripts', 'site-assets', 'site.json'), 'utf8'));
  return { url: `${origin}/functions/v1/app/mcp`, origin, timeout: 60 };
}

