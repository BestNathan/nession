'use strict';
// #2735 SC-02: a successful seed publishes a private CoW-backed dependency
// target without a full-copy fallback or workspace-member artifacts. A busy
// source, a source mutated during the copy, a clone failure and a workspace
// clean failure publish nothing and leave the source untouched.
const {
  run, targetSha, selftestOutput, assertMarkers,
} = require('../../../shared/worktree-seed-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const output = selftestOutput();
  assertMarkers(output, [
    'linux reflink seeds a private dependency target',
    'darwin clone allocation refuses a full-copy fallback',
    'an active Cargo build is a safe skip',
    'a source that changes during the copy is discarded',
    'a clone failure leaves no partial target',
    'a workspace-clean failure leaves no partial target',
  ]);
  evidence.push({
    type: 'runtime',
    value: 'exact SHA ' + sha + ': the seeded target keeps dependency artifacts, removes workspace-member artifacts, ' +
      'leaves the source target unchanged, and is a distinct private directory',
  });
  evidence.push({
    type: 'runtime',
    value: 'the Darwin allocation check rejects a copy that consumes more than the CoW limit; an active Cargo lock or a source changed during the copy is skipped',
  });
  evidence.push({
    type: 'runtime',
    value: 'clone and workspace-clean failures leave no partial target; the source is never mutated by the seed',
  });
  return 'the seed publishes only a complete private CoW-backed dependency target; unsafe sources and failures publish nothing';
});
