'use strict';
// #4302 SC-03: if a timed-out kill is nevertheless admitted later, it still
// checks the caller-observed incarnation at execution time. A guarded kill
// queued behind the lane while a controlled A→B replacement lands conflicts
// when it starts — it does not kill the replacement as an implicit retry.
const { run, targetSha, crateTests, assertRan, isolatedTmuxEnv } =
  require('../../../shared/mcp-cases.cjs');

const TEST = 'mcp::a_queued_guarded_kill_conflicts_after_a_controlled_replacement';

run(({ evidence }) => {
  const sha = targetSha();
  const out = crateTests(
    'nession-agent',
    ['--test', 'integration', TEST],
    110000,
    isolatedTmuxEnv('nession-4302-sc03-late-conflict'),
  );
  assertRan(out, [TEST]);
  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': a queued guarded kill that started after a controlled kill-and-' +
      'recreate of the same name returned conflict and left the replacement running; it did not ' +
      'reinterpret the later Session as the caller\'s target',
  });
  return 'A late-started guarded kill refuses a replacement Session instead of retrying against it';
});
