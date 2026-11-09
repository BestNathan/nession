'use strict';
// #845 SC-16 (runtime half): the source-aligned Cases and browser test exist
// at the exact target SHA, one Case per criterion, with a browser proof.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pass, run } = require('../../../shared/git-write-cases.cjs');

const root = path.resolve(__dirname, '../../../../..');

function checkoutSha() {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 10_000,
  }).trim();
}

run(async () => {
  const sha = process.env.NESSION_ACCEPTANCE_TARGET_SHA;
  assert.match(String(sha || ''), /^[0-9a-f]{40}$/, 'exact target SHA is required');
  assert.equal(checkoutSha(), sha, 'the Case tree must be the exact target SHA');

  const scs = Array.from({ length: 15 }, (_, index) => 'SC-' + String(index + 1).padStart(2, '0'));
  for (const sc of [...scs, 'SC-16']) {
    const dir = path.join(root, 'e2e', 'acceptance', 'cases', '845', sc);
    const manifest = path.join(dir, 'case.yaml');
    assert.ok(fs.existsSync(manifest), sc + ' manifest is missing');
    const text = fs.readFileSync(manifest, 'utf8');
    assert.match(text, /^issue: 845$/m, sc + ' must bind issue 845');
    assert.match(text, /^stage: pre-merge$/m, sc + ' must be a pre-merge Case');
    assert.match(text, /^criterion: /m, sc + ' must name its criterion');
    assert.ok(
      fs.readdirSync(dir).some((entry) => /^verify\.(js|spec\.js)$/.test(entry)),
      sc + ' must carry a verifier',
    );
  }

  const browserSpec = path.join(root, 'e2e', 'tests', 'browser', 'fixture-git.spec.ts');
  const browser = fs.readFileSync(browserSpec, 'utf8');
  assert.match(browser, /stage, confirm, and commit from the Changes surface/);
  assert.match(browser, /offers the three local writes and nothing beyond them/);

  return pass(
    'All sixteen #845 criteria have source-aligned pre-merge Cases at the exact target SHA, and the browser suite carries the stage/commit flow.',
    [
      { type: 'runtime', value: 'checkout HEAD equals the target SHA ' + sha },
      { type: 'runtime', value: 'case.yaml + verifier present for SC-01..SC-16 under e2e/acceptance/cases/845' },
      { type: 'source', value: 'e2e/tests/browser/fixture-git.spec.ts contains the write-flow and write-surface tests' },
      { type: 'boundary', value: 'the protocol Cases (SC-01..SC-15) prove the real-stack behavior; this Case checks the required source-aligned layout and browser entry point' },
    ],
  );
});
