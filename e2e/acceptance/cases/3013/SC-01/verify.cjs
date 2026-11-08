'use strict';
// #3013 SC-01: the filtered Sessions Linux baselines carry the quiet
// bordered-field focus state and their migration-parity pins agree with the
// exact files. The named E2E specs are the browser-level proof.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '../../../../..');
const MANIFEST = 'e2e/tests/browser/migration-parity.json';
const COMPONENTS = 'docs/design/design-system/components.md';
const SNAPSHOTS = [
  {
    key: '__snapshots__/fixture-visual.spec.ts/app-sessions-filtered-linux.png',
    file: 'e2e/tests/browser/__snapshots__/fixture-visual-app.spec.ts/app-sessions-filtered-linux.png',
    width: 390,
    height: 844,
  },
  {
    key: '__snapshots__/fixture-visual.spec.ts/app-sessions-filtered-375-linux.png',
    file: 'e2e/tests/browser/__snapshots__/fixture-visual-app-compact.spec.ts/app-sessions-filtered-375-linux.png',
    width: 375,
    height: 812,
  },
];

function pngSize(file) {
  const bytes = fs.readFileSync(file);
  assert.equal(bytes.toString('ascii', 1, 4), 'PNG', 'not a PNG: ' + file);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function main() {
  const target = process.env.NESSION_ACCEPTANCE_TARGET_SHA || '';
  assert.match(target, /^[a-f0-9]{40}$/, 'exact target SHA required');
  assert.equal(
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    target,
    'Case checkout SHA mismatch',
  );
  const manifest = JSON.parse(fs.readFileSync(path.join(root, MANIFEST), 'utf8'));
  const components = fs.readFileSync(path.join(root, COMPONENTS), 'utf8');
  assert.match(components,
    /the existing border repaints in `ring`; no outline or ring is added/,
    'bordered-field focus contract changed');
  const evidence = [];
  for (const snapshot of SNAPSHOTS) {
    const file = path.join(root, snapshot.file);
    const stat = fs.lstatSync(file);
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'unsafe baseline file');
    const { width, height } = pngSize(file);
    assert.deepEqual({ width, height }, { width: snapshot.width, height: snapshot.height },
      'baseline dimensions changed');
    const sha = execFileSync('git', ['hash-object', snapshot.file],
      { cwd: root, encoding: 'utf8' }).trim();
    assert.match(sha, /^[a-f0-9]{40}$/, 'invalid Git blob hash');
    assert.equal(manifest.baseline_png_blobs[snapshot.key], sha,
      'migration-parity pin mismatch for ' + snapshot.key);
    evidence.push({
      type: 'runtime',
      value: snapshot.file + ' is ' + width + 'x' + height + ' and pinned to ' + sha,
    });
  }
  process.stdout.write(JSON.stringify({
    status: 'pass',
    summary: 'The two filtered Sessions baselines carry the quiet bordered-field focus state and are pinned consistently in migration-parity.json.',
    evidence,
  }) + '\n');
}

try {
  main();
} catch (error) {
  process.stdout.write(JSON.stringify({
    status: 'fail',
    summary: String(error && error.message ? error.message : error).slice(-4000),
    evidence: [{ type: 'runtime', value: 'visual baseline/manifest proof failed' }],
  }) + '\n');
  process.exitCode = 1;
}
