import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const script = fileURLToPath(new URL('../scripts/mcp-smoke.mjs', import.meta.url));

function tempState(t) {
  const directory = mkdtempSync(join(tmpdir(), 'tender-desk-smoke-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

async function launch(t, directory) {
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, TENDER_DESK_PORT: '0', TENDER_DESK_STATE_DIR: directory },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exit = once(child, 'exit');
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exit;
  };
  t.after(stop);
  let output = '';
  child.stderr.on('data', (chunk) => { output += chunk; });
  const lines = createInterface({ input: child.stdout });
  const ready = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`Probe exited before ready (${code}): ${output}`)));
    lines.on('line', (line) => {
      output += `${line}\n`;
      const event = JSON.parse(line);
      if (event.event === 'listening') resolve(event);
    });
  });
  return { ready, stop, output: () => output };
}

test('launcher creates private credentials, binds loopback, and reuses credentials after restart', { timeout: 10000 }, async (t) => {
  const directory = tempState(t);
  const first = await launch(t, directory);
  const credentialPath = join(directory, 'mcp-authorization.txt');
  const authorization = readFileSync(credentialPath, 'utf8').trim();
  assert.ok(/^Bearer [a-f0-9]{64}$/.test(authorization));
  assert.equal(statSync(credentialPath).mode & 0o777, 0o600);
  assert.equal(new URL(first.ready.url).hostname, '127.0.0.1');
  assert.equal(first.ready.authorization_file, credentialPath);

  const client = new Client({ name: 'launcher-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(first.ready.url), {
    requestInit: { headers: { Authorization: authorization } },
  }));
  const result = await client.callTool({ name: 'health_check', arguments: { nonce: 'launcher-check' } });
  assert.ok(!result.isError);
  await client.close();
  await first.stop();
  assert.match(first.output(), /"nonce":"launcher-check"/);
  assert.ok(!first.output().includes(authorization.slice(7)));

  const second = await launch(t, directory);
  assert.ok(readFileSync(credentialPath, 'utf8').trim() === authorization);
  assert.ok(!second.output().includes(authorization.slice(7)));
  await second.stop();
});

test('launcher refuses an invalid existing credential without overwriting it', { timeout: 10000 }, async (t) => {
  const directory = tempState(t);
  const path = join(directory, 'mcp-authorization.txt');
  writeFileSync(path, 'not-a-valid-credential', { mode: 0o600 });
  await assert.rejects(launch(t, directory), /Invalid MCP credential file/);
  assert.equal(readFileSync(path, 'utf8'), 'not-a-valid-credential');
});

test('launcher refuses a credential file readable by other users', { timeout: 10000 }, async (t) => {
  const directory = tempState(t);
  const path = join(directory, 'mcp-authorization.txt');
  writeFileSync(path, `Bearer ${'a'.repeat(64)}`, { mode: 0o644 });
  await assert.rejects(launch(t, directory), /MCP credential file must have mode 0600/);
});
