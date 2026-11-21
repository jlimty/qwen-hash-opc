import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProbeServer } from '../src/mcp-smoke.mjs';

try {
  const port = Number(process.env.TENDER_DESK_PORT ?? 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('TENDER_DESK_PORT must be an integer between 0 and 65535.');
  }
  const directory = resolve(process.env.TENDER_DESK_STATE_DIR ?? fileURLToPath(new URL('../.local/', import.meta.url)));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const authorizationFile = join(directory, 'mcp-authorization.txt');
  try {
    writeFileSync(authorizationFile, `Bearer ${randomBytes(32).toString('hex')}`, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  if ((statSync(authorizationFile).mode & 0o777) !== 0o600) {
    throw new Error('MCP credential file must have mode 0600.');
  }
  const authorization = readFileSync(authorizationFile, 'utf8').trim();
  if (!/^Bearer [a-f0-9]{64}$/.test(authorization)) {
    throw new Error('Invalid MCP credential file.');
  }
  const server = createProbeServer({
    token: authorization.slice(7),
    onHealthCheck: (result) => console.log(JSON.stringify({ event: 'health_check', ...result })),
  });
  server.on('error', (error) => {
    console.error(`MCP probe failed to listen (${error.code}).`);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(JSON.stringify({
      event: 'listening',
      url: `http://127.0.0.1:${server.address().port}/mcp`,
      authorization_file: authorizationFile,
    }));
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      server.close();
      server.closeAllConnections();
    });
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
