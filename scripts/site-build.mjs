import { mkdir, readFile, rm, writeFile, copyFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { backtestToJson, buildBacktest } from '../src/backtest.mjs';
import { parseTenderCsv } from '../src/tender-data.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'site');
// Ship exactly what the function imports: walk relative imports from the two entry modules.
async function importClosure(entries) {
  const seen = new Set();
  const queue = [...entries];
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    const source = await readFile(join(root, 'src', `${name}.mjs`), 'utf8');
    for (const [, target] of source.matchAll(/from '\.\/([^']+)\.mjs'/g)) queue.push(target);
  }
  return [...seen].sort();
}
const modules = await importClosure(['site-app', 'pg-database']);
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const { origin } = JSON.parse(await readFile(join(root, 'scripts', 'site-assets', 'site.json'), 'utf8'));
const pinned = (name) => pkg.dependencies[name];

await rm(join(out, 'functions'), { recursive: true, force: true });
await mkdir(join(out, 'functions'), { recursive: true });
await mkdir(join(out, 'dist'), { recursive: true });

for (const name of modules) {
  const source = await readFile(join(root, 'src', `${name}.mjs`), 'utf8');
  const rewritten = source
    .replaceAll("from 'zod'", `from 'npm:zod@${pinned('zod')}'`)
    .replaceAll("from 'csv-parse/sync'", `from 'npm:csv-parse@${pinned('csv-parse')}/sync'`);
  await writeFile(join(out, 'functions', `${name}.mjs`), rewritten);
}

const csv = await readFile(join(root, 'data', 'GovernmentProcurementviaGeBIZ.csv'), 'utf8');
const dataset = parseTenderCsv(csv);
await writeFile(join(out, 'functions', 'dataset-csv.mjs'), `export default ${JSON.stringify(csv)};\n`);
await writeFile(join(out, 'functions', 'backtest-data.mjs'), `export default ${JSON.stringify(backtestToJson(buildBacktest(dataset), dataset))};\n`);
await writeFile(join(out, 'functions', 'index.ts'), `import { Pool, types } from 'npm:@neondatabase/serverless@${pinned('@neondatabase/serverless')}';
import csv from './dataset-csv.mjs';
import backtestJson from './backtest-data.mjs';
import { createPoolDatabase, poolTypes } from './pg-database.mjs';
import { createSiteApp } from './site-app.mjs';

globalThis.addEventListener('unhandledrejection', (event) => event.preventDefault());
globalThis.addEventListener('error', (event) => event.preventDefault());

function openDatabase(connectionString) {
  const pool = new Pool({ connectionString, max: 2, types: poolTypes(types) });
  pool.on('error', (error) => console.error(\`database pool error: \${error?.name ?? 'Error'}\`));
  return createPoolDatabase(pool);
}

Deno.serve(createSiteApp({ openDatabase, env: (name) => Deno.env.get(name), csv, backtestJson, origin: ${JSON.stringify(origin)} }));
`);
await copyFile(join(root, 'scripts', 'site-assets', 'index.html'), join(out, 'dist', 'index.html'));
console.log(`Built ${out} (dataset ${dataset.dataset_sha256.slice(0, 12)}…, ${dataset.contracts.length} contracts)`);
