'use strict';
// Shared machinery for the #2735 worktree target-seed Cases.
//
// The seed and its selftest are developer tooling: their proof is the named
// deterministic scenario in scripts/seed-worktree-target-selftest.sh plus the
// native macOS/APFS receipt committed with SC-04. No browser or full-stack
// runtime state is involved; the Case runner still provides the exact target
// checkout and SHA, which is what these Cases pin.
const path = require('node:path');
const { run, checked, targetSha } = require('./control-mode-cases.cjs');

const root = path.resolve(__dirname, '../../..');

function selftestOutput() {
  return checked('bash', ['scripts/seed-worktree-target-selftest.sh'], 120000);
}

function assertMarkers(output, markers) {
  for (const marker of markers) {
    if (!output.includes(marker)) {
      throw new Error('missing deterministic selftest marker: ' + marker);
    }
  }
}

module.exports = { run, checked, targetSha, root, selftestOutput, assertMarkers };
