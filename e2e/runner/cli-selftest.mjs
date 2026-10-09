// The canonical E2E dispatcher must fail closed and never claim zero-work Pass.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
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
const migration = JSON.parse(fs.readFileSync(path.join(repo, 'e2e', 'tests', 'browser', 'migration-parity.json'), 'utf8'));
assert.equal(migration.schema_version, 1);
assert.match(migration.source_sha, /^[a-f0-9]{40}$/);
const browserRoot = path.join(repo, 'e2e', 'tests', 'browser');
assert.equal(fs.existsSync(path.join(repo, 'e2e', 'specs')), false, 'legacy tests must be retired');
const foundSpecs = fs.readdirSync(browserRoot).filter(name => name.endsWith('.spec.ts')).sort();
assert.deepEqual(foundSpecs, migration.specs, 'browser spec inventory changed during migration');
assert.equal(foundSpecs.length, 21, 'baseline migration needs all 21 spec files');
assert.equal(catalog.browserTests, 21, 'catalog may not silently count duplicates or omit specs');
const pngRoot = path.join(browserRoot, '__snapshots__', 'fixture-visual.spec.ts');
const foundPngs = fs.readdirSync(pngRoot).filter(name => name.endsWith('.png')).sort();
const pinned = Object.keys(migration.baseline_png_blobs).map(file => path.basename(file)).sort();
assert.deepEqual(foundPngs, pinned, 'snapshot inventory mismatch');
assert.equal(foundPngs.length, 43, 'all 43 snapshots must migrate unchanged');
for (const [relative, expectedSha] of Object.entries(migration.baseline_png_blobs)) {
  const filename = path.resolve(browserRoot, relative);
  assert.ok(filename.startsWith(browserRoot + path.sep), 'snapshot path escaped browser tree');
  assert.equal(fs.lstatSync(filename).isSymbolicLink(), false, 'snapshots must be real files');
  const bytes = fs.readFileSync(filename);
  const actual = createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex');
  assert.equal(actual, expectedSha, 'visual baseline bytes changed: ' + relative);
}

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
  const fixture = (target, restored) => ({
    schema_version: 1, kind: 'e2e_scenario_observation', scenario: 'terminal-attach-resume',
    target_sha: target.repeat(40), config_sha256: 'c'.repeat(64),
    status: 'Completed', evaluation: null, observation_count: 3,
    observations: [
      { at: '2026-10-09T00:00:00.000Z', stage: 'before-reload',
        browser: { marker_count: 1, mounted: true }, backend: { marker_count: 240 } },
      { at: '2026-10-09T00:00:01.000Z', stage: 'after-reload',
        browser: { marker_count: 20, mounted: true }, backend: { marker_count: 240 } },
      { at: '2026-10-09T00:00:02.000Z', stage: 'after-reload',
        browser: { marker_count: restored, mounted: true }, backend: { marker_count: 240 } },
    ],
  });
  fs.writeFileSync(left, JSON.stringify(fixture('a', 100)));
  fs.writeFileSync(right, JSON.stringify(fixture('b', 240)));
  const compared = call('compare', left, right);
  assert.equal(compared.code, 0);
  const delta = JSON.parse(compared.stdout);
  assert.equal(delta.evaluation, null);
  assert.equal(delta.differences.some((item) => item.field === 'target_sha'), true);
  assert.equal(delta.scenario, 'terminal-attach-resume');
  assert.equal(delta.config_comparable, true);
  assert.equal(delta.left.timeline.length, 3);
  assert.equal(delta.observed_delta.final_browser_marker_count, 140);
  assert.match(delta.limitations, /not synchronized/);
  const corrupt = fixture('a', 240);
  corrupt.observations[1].browser.marker_count = -1;
  fs.writeFileSync(right, JSON.stringify(corrupt));
  expectError('compare', left, right);
  corrupt.observations[1].browser.marker_count = 20;
  corrupt.observation_count = 4;
  fs.writeFileSync(right, JSON.stringify(corrupt));
  expectError('compare', left, right);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
console.log('canonical E2E CLI self-test: catalog, validation, error/empty and compare contracts passed');
