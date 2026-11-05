'use strict';
// #2735 SC-05: existing Linux reflink, incompatible-input, existing-target and
// target-isolation checks keep passing; the focused seed Gate owns the Darwin
// regression and the build-cache verifier keeps its isolation-only scope.
const fs = require('node:fs');
const path = require('node:path');
const {
  run, checked, targetSha, root, selftestOutput, assertMarkers,
} = require('../../../shared/worktree-seed-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const output = selftestOutput();
  assertMarkers(output, [
    'linux reflink seeds a private dependency target',
    'linux reflink-unavailable is an expected skip',
    'an existing destination target is never overwritten',
    'incompatible Cargo inputs cold-start',
  ]);

  checked('./gates/run', ['worktree-target-seed', 'build-cache-verifier'], 120000);

  const seedGate = fs.readFileSync(path.join(root, 'gates/checks/worktree-target-seed.sh'), 'utf8');
  if (!seedGate.includes('scripts/seed-worktree-target-selftest.sh')) {
    throw new Error('the focused seed Gate no longer runs the seed selftest');
  }
  if (seedGate.includes('build-cache-verify-selftest.sh')) {
    throw new Error('the seed Gate absorbed the isolation verifier instead of staying focused');
  }
  const cacheGate = fs.readFileSync(path.join(root, 'gates/checks/build-cache-verifier.sh'), 'utf8');
  if (!cacheGate.includes('scripts/build-cache-verify-selftest.sh')) {
    throw new Error('the build-cache verifier Gate no longer owns its isolation selftest');
  }

  evidence.push({
    type: 'runtime',
    value: 'exact SHA ' + sha + ': linux reflink and reflink-unavailable, incompatible inputs and an existing target ' +
      'all preserve the seed contract; target isolation remains private',
  });
  evidence.push({
    type: 'runtime',
    value: 'worktree-target-seed runs the focused selftest (including the Darwin regression), while build-cache-verifier still runs its isolation selftest',
  });
  return 'existing Linux/skip/isolation checks stay green and the two Gates keep their separate contracts';
});
