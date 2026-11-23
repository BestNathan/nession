'use strict';
// #4302 SC-01: the identity check and the termination are serialized in the
// Agent's shared keyed Session mutation lane. This drives the controlled
// interleaving: a guarded kill queued behind a lane blocker, with a real A→B
// replacement landing before the lane admits it, must conflict when it starts
// and must leave B running with B's own incarnation.
const { run, targetSha, crateTests, assertRan, isolatedTmuxEnv } =
  require('../../../shared/mcp-cases.cjs');

const TEST = 'mcp::a_queued_guarded_kill_conflicts_after_a_controlled_replacement';

run(({ evidence }) => {
  const sha = targetSha();
  const out = crateTests(
    'nession-agent',
    ['--test', 'integration', TEST],
    110000,
    isolatedTmuxEnv('nession-4302-sc01-interleaving'),
  );
  assertRan(out, [TEST]);
  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': a guarded kill queued on the Session key was admitted only after ' +
      'a controlled kill-and-recreate of the same name; it returned conflict, and the ' +
      'replacement Session stayed alive with its own instance id before a caller that saw B ' +
      'killed it successfully',
  });
  return 'The check and the kill are serialized at the Agent owner, so a replacement that interleaves ahead of a queued kill is never terminated';
});
