'use strict';
// #4302 SC-01: with incarnation A observed and a same-name B live, a guarded
// kill carrying A is refused as `conflict` at the Agent's authoritative
// Session mutation owner; B keeps running, keeps its own durable identity and
// keeps its binding record. A matching precondition still kills exactly once,
// a missing Session stays `not_found`, and the legacy name-only kill is
// unchanged.
const { run, targetSha, crateTests, assertRan, isolatedTmuxEnv } =
  require('../../../shared/mcp-cases.cjs');

const TESTS = [
  'tmux::manager::guarded_kill_tests::a_stale_expected_instance_never_kills_the_replacement',
  'tmux::manager::guarded_kill_tests::a_matching_expected_instance_kills_exactly_once',
  'tmux::manager::guarded_kill_tests::an_absent_precondition_preserves_the_legacy_name_kill',
  'tmux::manager::guarded_kill_tests::a_guarded_kill_of_a_missing_session_is_not_found',
];

run(({ evidence }) => {
  const sha = targetSha();
  const out = crateTests(
    'nession-agent',
    ['--lib', 'tmux::manager::guarded_kill_tests::'],
    110000,
    isolatedTmuxEnv('nession-4302-sc01-owner'),
  );
  assertRan(out, TESTS);
  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ' on real isolated tmux: a kill carrying stale instance A was refused ' +
      'as conflict while replacement B stayed running with its own instance id and binding ' +
      'record; a matching instance was killed exactly once and then reported not_found; the ' +
      'legacy absent-precondition kill and the missing-name not_found refusal were unchanged',
  });
  return 'A stale guarded kill never terminates a same-name replacement, and a matching guarded kill kills exactly once';
});
