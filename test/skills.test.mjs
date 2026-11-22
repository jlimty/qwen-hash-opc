import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../skills/', import.meta.url);
const skill = (name) => readFile(new URL(`${name}/SKILL.md`, root), 'utf8');

test('every skill names its own folder in frontmatter and never says the retired operator title', async () => {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const text = await skill(entry.name);
    assert.match(text, new RegExp(`^---\\nname: ${entry.name}\\n`), entry.name);
    assert.doesNotMatch(text, new RegExp('fou' + 'nder', 'i'), entry.name);
  }
});

test('intake shows the personal connector once, with the paste instruction', async () => {
  const text = await skill('tender-desk-intake');
  assert.match(text, /connector_config/);
  assert.match(text, /Paste this into QwenWork → Connectors\. It will not be shown again\./);
  assert.match(text, /GeBIZ tender number/);
});

test('analyst confirms before submitting, handles escalation there, and answers where the brief is', async () => {
  const text = await skill('tender-desk-analyst');
  assert.match(text, /Submitting takes the advice slot for this tender/);
  assert.match(text, /Where's my brief\?/);
  assert.doesNotMatch(text, /exclusive hold/i);
});

test('scout no longer claims pricing takes a hold, and still never prices', async () => {
  const text = await skill('tender-desk-scout');
  assert.doesNotMatch(text, /exclusive hold/i);
  assert.match(text, /Never call `request_pricing`/);
});

test('proposal reuses an approved brief when one exists', async () => {
  assert.match(await skill('tender-desk-proposal'), /approved brief/i);
});
