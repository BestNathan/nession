'use strict';
// #2735 SC-03: WorktreeCreate stays successful when the seed is unavailable,
// reports seeded / skipped / failed distinctly, and gives an applicable retry
// path when a destination target already exists.
const {
  run, targetSha, selftestOutput, assertMarkers,
} = require('../../../shared/worktree-seed-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const output = selftestOutput();
  assertMarkers(output, [
    'an existing destination target is never overwritten',
    'replace keeps the previous target as a backup',
    'an interrupted replace restores the original target',
    'WorktreeCreate reports a seeded target',
    'WorktreeCreate reports a skipped target with a retry path',
    'WorktreeCreate reports a failed seed and still creates the worktree',
  ]);
  evidence.push({
    type: 'runtime',
    value: 'exact SHA ' + sha + ': the hook keeps the worktree path on stdout and reports seeded, skipped and failed ' +
      'outcomes on stderr; a failed seed still creates the worktree',
  });
  evidence.push({
    type: 'runtime',
    value: 'an existing target is never overwritten; seed-worktree-target-replace publishes a new seed and keeps the old target as a backup',
  });
  return 'WorktreeCreate distinguishes seeded, skipped and failed seeds, always succeeds, and documents a safe retry';
});
