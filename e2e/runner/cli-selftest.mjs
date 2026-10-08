// The canonical E2E dispatcher must fail closed and never claim zero-work Pass.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const cli = path.join(repo, 'e2e', 'run');
const call = (...args) => {
  const run = spawnSync(process.execPath, [cli, ...args], {
    cwd: repo, encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, CI: '' },
  });
  if (run.error) throw run.error;
  return { code: run.status, stdout: run.stdout, stderr: run.stderr };
};
const expectError = (...args) => {
  const result = call(...args);
  assert.equal(result.code, 2, 'expected deterministic Error for: ' + args.join(' ') +
    '; stdout=' + result.stdout + '; stderr=' + result.stderr);
  assert.match(result.stderr, /E2E Error:/);
};
const listed = call('--list');
assert.equal(listed.code, 0);
const catalog = JSON.parse(listed.stdout);
assert.ok(catalog.browserTests > 0, 'regression catalog must never silently report 0 suites');
assert.ok(catalog.cases.length > 0, 'Case catalog must discover source-aligned Cases');
assert.ok(catalog.scenarios.length > 0, 'scenario catalog must not silently disappear');

const checked = call('--validate');
assert.equal(checked.code, 0);
assert.ok(JSON.parse(checked.stdout).case_count > 0);

expectError('test');
expectError('test', '--all'); // CI-only: prevents unsafe local stack launch
expectError('test', '--suite', '../escape');
expectError('acceptance', '--issue', '0', '--sc', 'SC-01',
  '--sha', 'a'.repeat(40), '--stage', 'staging');
expectError('acceptance', '--issue', '1474', '--sc', 'SC-9999',
  '--sha', 'b'.repeat(40), '--stage', 'staging');
expectError('scenario', 'not-declared');
expectError('scenario', 'terminal-attach-resume');
expectError('compare', 'missing-file.json');
expectError('unknown');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-run-cli-selftest-'));
try {
  const left = path.join(temp, 'left.json');
  const right = path.join(temp, 'right.json');
  fs.writeFileSync(left, JSON.stringify({ kind: 'e2e_scenario_observation',
    target_sha: 'a'.repeat(40), result: 'Completed' }));
  fs.writeFileSync(right, JSON.stringify({ kind: 'e2e_scenario_observation',
    target_sha: 'b'.repeat(40), result: 'Completed' }));
  const compared = call('compare', left, right);
  assert.equal(compared.code, 0);
  const delta = JSON.parse(compared.stdout);
  assert.equal(delta.evaluation, null);
  assert.equal(delta.differences.some((item) => item.field === 'target_sha'), true);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
console.log('canonical E2E CLI self-test: catalog, validation, error/empty and compare contracts passed');
