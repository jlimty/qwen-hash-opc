import assert from 'node:assert/strict';
import test from 'node:test';
import { parseReference, referenceCode, referenceLabel } from '../src/references.mjs';

test('referenceCode pads to five digits and grows past them', () => {
  assert.equal(referenceCode('BRF', 12), 'BRF00012');
  assert.equal(referenceCode('AUD', 123456), 'AUD123456');
  assert.equal(referenceCode('CLI', 3n), 'CLI00003');
  assert.equal(referenceCode('PRJ', '7'), 'PRJ00007');
});

test('parseReference accepts only uppercase known prefixes with five or more digits', () => {
  assert.deepEqual(parseReference('BRF00012'), { prefix: 'BRF', number: 12 });
  assert.deepEqual(parseReference('AUD123456'), { prefix: 'AUD', number: 123456 });
  for (const bad of ['brf00012', 'BRF1', 'XYZ00001', 'BRF00012/x', '', 'BRF000-1', undefined]) {
    assert.equal(parseReference(bad), null, String(bad));
  }
});

test('referenceLabel joins code and subject, or falls back to the code', () => {
  assert.equal(referenceLabel('CLI', 3, 'Cedar Markets'), 'CLI00003 - Cedar Markets');
  assert.equal(referenceLabel('CLI', 3, ''), 'CLI00003');
  assert.equal(referenceLabel('CLI', 3), 'CLI00003');
});
