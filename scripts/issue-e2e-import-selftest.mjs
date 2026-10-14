#!/usr/bin/env node
// Importing reusable Issue E2E modules must never execute their CLI branches.
// Run each import in a new Node process to surface side effects exactly as CI does.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const modules = [
  'scripts/issue-e2e-plan.mjs',
  'e2e/runner/selected-report.mjs',
  'scripts/issue-e2e-selection-entry.mjs',
  'scripts/issue-e2e-collect.mjs',
  'scripts/issue-e2e-gate.mjs',
  'scripts/issue-e2e-reconcile.mjs',
  'scripts/issue-e2e-source-attestation.mjs',
];
for (const mod of modules) {
  const result = spawnSync(process.execPath,
    ['--input-type=module', '-e', 'await import(' + JSON.stringify('./' + mod) + ')'],
    { cwd: process.cwd(), encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, mod + ' must import without running its CLI: ' + result.stderr);
  assert.equal(result.stdout.trim(), '', mod + ' import must not emit runtime CLI output');
}
for (const mod of modules.filter(x => !x.endsWith('source-attestation.mjs'))) {
  const result = spawnSync(process.execPath, [mod, 'self-test'],
    { cwd: process.cwd(), encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, mod + ' direct CLI self-test regressed: ' + result.stderr);
}
console.log('Issue E2E import/CLI contracts: ' + modules.length + ' import negatives and direct CLI self-tests passed');
