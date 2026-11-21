import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

const execute = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/governance-demo.mjs', import.meta.url));

test('local governance demo runs the real dataset journey without exposing credentials or holdout outcomes', async () => {
  const { stdout } = await execute(process.execPath, [script], { cwd: tmpdir(), maxBuffer: 500000 });
  const result = JSON.parse(stdout);
  assert.match(result.purpose, /scripted/i);
  assert.match(result.purpose, /not a QwenWork run/i);
  assert.equal(result.dataset_id, 'd_acde1106003906a75c3fa052592f2fcb');
  assert.equal(result.incoming_tender.data_kind, 'historical-backtest');
  assert.deepEqual(Object.keys(result.incoming_tender).sort(), ['agency', 'category', 'data_kind', 'description', 'tender_no']);
  assert.ok(result.pricing.n >= 5);
  assert.match(result.pricing.stat_id, /^stat_[a-f0-9]{64}$/);
  assert.equal(result.final_brief_status, 'approved');
  assert.ok(result.steps.some((s) => s.outcome === 'escalated' && s.rule_id === 'G2'));
  for (const rule of ['G1', 'G3', 'G4']) assert.ok(result.steps.some((s) => s.outcome === 'blocked' && s.rule_id === rule));
  assert.ok(result.steps.some((s) => s.action === 'submit_valid_brief' && s.status === 'pending_approval'));
  assert.ok(result.audit.some((s) => s.action === 'review_brief' && s.outcome === 'approved'));
  assert.ok(result.audit.every((s) => !('client_id' in s) && !('actor' in s)));
  assert.doesNotMatch(stdout, /Bearer\s|"token"\s*:|token_hash|founderToken|"actual_award"|"suppliers"/);
  assert.ok(stdout.length < 15000);
});
