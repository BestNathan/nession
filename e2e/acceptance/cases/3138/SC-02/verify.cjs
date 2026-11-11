'use strict';
// #3138 SC-02 (focused visual remainder).
//
// The browser verifiers prove the relational computed-style/bounds behavior.
// This runtime verifier proves the small canonical screenshot set exists in the
// exact checked-out tree, is referenced by the fixture-visual spec that
// produces it, and is a real full-frame image at the expected viewport width —
// not a placeholder or a stale uncommitted file. It deliberately does not
// compare pixels; the Design Gate's Playwright run owns that comparison.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.cwd();

const BASELINES = [
  {
    spec: 'e2e/tests/browser/fixture-visual.spec.ts',
    directory: 'e2e/tests/browser/__snapshots__/fixture-visual.spec.ts',
    screenshot: 'web-project-detail.png',
    platformFile: 'web-project-detail-linux.png',
    width: 1440,
    minHeight: 900,
  },
  {
    spec: 'e2e/tests/browser/fixture-visual.spec.ts',
    directory: 'e2e/tests/browser/__snapshots__/fixture-visual.spec.ts',
    screenshot: 'web-sandbox-outside.png',
    platformFile: 'web-sandbox-outside-linux.png',
    width: 1440,
    minHeight: 900,
  },
  {
    spec: 'e2e/tests/browser/fixture-visual.spec.ts',
    directory: 'e2e/tests/browser/__snapshots__/fixture-visual.spec.ts',
    screenshot: 'web-sandbox-inside.png',
    platformFile: 'web-sandbox-inside-linux.png',
    width: 1440,
    minHeight: 900,
  },
  {
    spec: 'e2e/tests/browser/fixture-visual-app.spec.ts',
    directory: 'e2e/tests/browser/__snapshots__/fixture-visual-app.spec.ts',
    screenshot: 'app-project-detail.png',
    platformFile: 'app-project-detail-linux.png',
    width: 390,
    minHeight: 844,
  },
  {
    spec: 'e2e/tests/browser/fixture-visual-app.spec.ts',
    directory: 'e2e/tests/browser/__snapshots__/fixture-visual-app.spec.ts',
    screenshot: 'app-sandbox-inside.png',
    platformFile: 'app-sandbox-inside-linux.png',
    width: 390,
    minHeight: 844,
  },
];

function pngSize(filename) {
  const buffer = fs.readFileSync(filename);
  assert.ok(buffer.length > 10_000, path.basename(filename) + ' is too small to be a real screen');
  assert.equal(buffer.subarray(1, 4).toString('ascii'), 'PNG', path.basename(filename) + ' is not a PNG');
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    bytes: buffer.length,
  };
}

function trackedBlob(relative) {
  const inside = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim();
  assert.equal(inside, 'true', 'the acceptance checkout must be a git worktree');
  return execFileSync('git', ['rev-parse', 'HEAD:' + relative], {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim();
}

function main() {
  const evidence = [];
  for (const baseline of BASELINES) {
    const specFile = path.join(ROOT, baseline.spec);
    const spec = fs.readFileSync(specFile, 'utf8');
    assert.ok(
      spec.includes(`'${baseline.screenshot}'`),
      baseline.spec + ' does not reference the ' + baseline.screenshot + ' baseline',
    );

    const relative = path.join(baseline.directory, baseline.platformFile);
    const absolute = path.join(ROOT, relative);
    assert.ok(fs.existsSync(absolute), relative + ' is missing from the checked-out tree');
    const size = pngSize(absolute);
    assert.equal(size.width, baseline.width, relative + ' width');
    assert.ok(size.height >= baseline.minHeight, relative + ' is shorter than the canonical viewport');
    const blob = trackedBlob(relative);

    evidence.push({
      type: 'source',
      value:
        relative + ' is ' + size.width + 'x' + size.height + ' (' + size.bytes + ' bytes, blob ' +
        blob.slice(0, 12) + '), referenced by ' + baseline.spec +
        ' at the canonical viewport width',
    });
  }

  process.stdout.write(
    JSON.stringify({
      status: 'pass',
      summary:
        'The focused #3138 visual baseline set is committed at the exact target tree and produced by the canonical fixture-visual specs',
      evidence,
    }) + '\n',
  );
}

main().catch((error) => {
  process.stdout.write(
    JSON.stringify({
      status: 'fail',
      summary: String(error && error.message ? error.message : error).slice(-4400),
      evidence: [
        {
          type: 'runtime',
          value: 'the focused Project/Sandbox baseline set or its spec reference could not be verified',
        },
      ],
    }) + '\n',
  );
  process.exitCode = 1;
});
