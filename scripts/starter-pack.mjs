// Builds the "Get started" pack the admin publishes on the Hashmeta site: the public intake connector and one
// installable zip per client skill (QwenWork's Install Skill dialog takes a .zip containing SKILL.md).
// Output goes under the git-ignored state directory because the intake JSON carries a live key.
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const skills = ['tender-desk-intake', 'tender-desk-scout', 'tender-desk-analyst', 'tender-desk-proposal'];
const readme = `Tender Desk: get started

1. Install the four skills in QwenWork (Install Skill: drop each .zip):
   ${skills.map((s) => `${s}.zip`).join(', ')}.
2. Paste tender-desk-intake.json into QwenWork -> Connectors.
3. Start a chat with "Register my company". At the end you get your own connector, shown once.
   Paste it into Connectors the same way; from then on ask for a shortlist or a brief.

The demo clients are fictional. Tenders are historical GeBIZ awards replayed as a backtest, not live opportunities.
`;

try {
  const { values } = parseArgs({ options: { 'state-dir': { type: 'string' } }, allowPositionals: false, strict: true });
  const stateDir = resolve(values['state-dir'] ?? join(root, '.local', 'site'));
  const out = join(stateDir, 'starter-pack');
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true, mode: 0o700 });
  await copyFile(join(stateDir, 'connectors', 'tender-desk-intake.json'), join(out, 'tender-desk-intake.json'));
  for (const skill of skills) {
    execFileSync('zip', ['-q', '-j', '-X', join(out, `${skill}.zip`), join(root, 'skills', skill, 'SKILL.md')]);
  }
  await writeFile(join(out, 'README.txt'), readme);
  console.log(`Wrote the starter pack to ${out} (the intake JSON holds the public intake key; publish it only on the Hashmeta site).`);
} catch (error) {
  console.error(`Starter pack failed: ${error.message}`);
  process.exitCode = 1;
}
