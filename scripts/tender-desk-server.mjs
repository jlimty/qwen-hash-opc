import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { PGlite } from '@electric-sql/pglite';
import { initializeGovernance } from '../src/governance-db.mjs';
import { loadFounderToken, seedDemo } from './lib/seed.mjs';
import { createTenderDesk } from '../src/governance.mjs';
import { createConsoleServer } from '../src/console.mjs';
import { createTenderDeskServer } from '../src/mcp-business.mjs';
import { parseTenderCsv } from '../src/tender-data.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let database;
let server;
let consoleServer;
try {
  const { values } = parseArgs({ options: { 'seed-demo': { type: 'boolean' } }, allowPositionals: false, strict: true });
  const stateDir = resolve(process.env.TENDER_DESK_STATE_DIR ?? join(root, '.local'));
  const port = Number(process.env.TENDER_DESK_PORT ?? 8788);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('TENDER_DESK_PORT must be an integer from 0 to 65535.');
  await mkdir(stateDir, { recursive: true, mode: 0o700 });

  const dataset = parseTenderCsv(await readFile(join(root, 'data', 'GovernmentProcurementviaGeBIZ.csv'), 'utf8'));
  database = await PGlite.create(join(stateDir, 'db'));
  await initializeGovernance(database);
  const founderTokenPath = join(stateDir, 'founder-token.txt');
  const founderToken = await loadFounderToken(founderTokenPath);
  const consolePort = Number(process.env.TENDER_DESK_CONSOLE_PORT ?? 8789);
  if (!Number.isInteger(consolePort) || consolePort < 0 || consolePort > 65535) throw new Error('TENDER_DESK_CONSOLE_PORT must be an integer from 0 to 65535.');
  const desk = createTenderDesk({ database, dataset, founderToken });
  const tokenDir = join(stateDir, 'agent-tokens');

  server = createTenderDeskServer({ authenticate: desk.agent });
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    for (const listener of [server, consoleServer]) await new Promise((done) => { listener.close(done); listener.closeAllConnections(); });
    await database.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  consoleServer = createConsoleServer({ founder: desk.founder, founderToken, dataset });
  for (const [listener, listenPort] of [[server, port], [consoleServer, consolePort]]) {
    listener.listen(listenPort, '127.0.0.1');
    await new Promise((resolveListening, reject) => { listener.once('listening', resolveListening); listener.once('error', reject); });
  }
  if (values['seed-demo']) {
    try { await seedDemo(desk.founder(founderToken), tokenDir); }
    catch (error) { throw new Error(`${error.message} If seeding stopped partway, delete the state directory's db and agent-tokens folders before retrying.`); }
  }
  console.log(`Tender Desk MCP listening at http://127.0.0.1:${server.address().port}/mcp`);
  console.log(`Founder console at http://127.0.0.1:${consoleServer.address().port}/ (secret file: ${founderTokenPath})`);
  console.log(`Agent credential files (one connector each, mode 0600): ${tokenDir}`);

} catch (error) {
  console.error(`Tender Desk server failed: ${error.message}`);
  process.exitCode = 1;
  server?.close();
  consoleServer?.close();
  await database?.close().catch(() => {});
}
