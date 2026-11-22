import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import { promisify } from 'node:util';

const run = promisify(execFile);
const functions = new URL('../site/functions/', import.meta.url);

test('the site build ships every module the function imports', async () => {
  await run(process.execPath, [new URL('../scripts/site-build.mjs', import.meta.url).pathname]);
  const shipped = new Set(await readdir(functions));
  const missing = [];
  for (const file of shipped) {
    if (!/\.(mjs|ts)$/.test(file)) continue;
    const source = await readFile(new URL(file, functions), 'utf8');
    for (const [, target] of source.matchAll(/from '\.\/([^']+)'/g)) if (!shipped.has(target)) missing.push(`${file} → ${target}`);
    assert.doesNotMatch(source, /from '(zod|csv-parse\/sync|postgres)'/, `${file} has an unpinned bare import`);
  }
  assert.deepEqual(missing, []);
  for (const required of ['references.mjs', 'connector-config.mjs', 'brief-risk.mjs', 'gebiz-check.mjs', 'console-records.mjs',
    'customer-handler.mjs', 'customer-view.mjs', 'customer-auth.mjs', 'neon-session.mjs', 'gebiz-feed.mjs', 'openrouter.mjs', 'brief-drafting.mjs', 'price-check.mjs', 'tender-reading.mjs']) {
    assert.ok(shipped.has(required), required);
  }
  const entry = await readFile(new URL('index.ts', functions), 'utf8');
  assert.match(entry, /waitUntil: globalThis\.EdgeRuntime\?\.waitUntil\?\.bind\(globalThis\.EdgeRuntime\)/);
});
