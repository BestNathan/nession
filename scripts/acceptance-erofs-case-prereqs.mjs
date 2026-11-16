#!/usr/bin/env node
// #3711: main-owned, bounded Ubuntu prerequisite admission for one real
// EROFS Compose Case. The target Case receives no provisioning credentials.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

export function requiresErofsTools(selection) {
  if (!Array.isArray(selection)) {
    throw new Error('trusted Case selection must be an array');
  }
  return selection.some(entry =>
    entry && typeof entry === 'object' && !Array.isArray(entry) &&
    entry.issue === 3696 && entry.criterion === 'SC-03' &&
    entry.platform === 'linux' && entry.runtime === 'full-stack-local');
}

function selfTest() {
  const eligible = { issue: 3696, criterion: 'SC-03',
    platform: 'linux', runtime: 'full-stack-local' };
  assert.equal(requiresErofsTools([eligible]), true);
  assert.equal(requiresErofsTools([eligible, { issue: 3700,
    criterion: 'SC-01', platform: 'linux' }]), true);
  for (const entry of [
    { ...eligible, issue: 3693 },
    { ...eligible, issue: '3696' },
    { ...eligible, criterion: 'SC-01' },
    { ...eligible, platform: 'macos' },
    { ...eligible, runtime: 'browser' },
    null, '3696/SC-03',
  ]) {
    assert.equal(requiresErofsTools([entry]), false);
  }
  assert.equal(requiresErofsTools([]), false);
  assert.throws(() => requiresErofsTools(null), /must be an array/);
  console.log('#3711 scoped EROFS Case prerequisite admission self-tests passed');
}

const action = process.argv[2];
if (action === 'self-test') selfTest();
else if (action === 'selected' && process.argv.length === 4) {
  const selection = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  console.log(requiresErofsTools(selection) ? 'true' : 'false');
} else throw new Error(
  'usage: acceptance-erofs-case-prereqs.mjs self-test | selected <selection.json>');
