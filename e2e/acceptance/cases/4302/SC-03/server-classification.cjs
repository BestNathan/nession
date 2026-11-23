'use strict';
// #4302 SC-03: the Server preserves outcome-indeterminate semantics. A guarded
// refusal is a typed reply that never removes registry state, a disconnected or
// offline Agent is refused as unavailable rather than treated as "gone", and
// the legacy name-only command keeps its exact shape so existing non-MCP
// consumers are not regressed.
const { run, targetSha, crateTests, assertRan } = require('../../../shared/mcp-cases.cjs');

const TESTS = [
  'server::handler::tests::server_session_kill_v1::session_kill_forwards_the_precondition_and_propagates_a_conflict',
  'server::handler::tests::server_session_kill_v1::session_kill_legacy_command_stays_name_addressed',
  'server::handler::tests::server_session_kill_v1::session_kill_guarded_refuses_an_offline_agent',
  'server::handler::tests::server_session_kill_v1::session_kill_reply_is_what_its_contract_says_it_is',
];

run(({ evidence }) => {
  const sha = targetSha();
  const out = crateTests(
    'nession-server',
    ['--lib', 'server::handler::tests::server_session_kill_v1'],
    110000,
  );
  assertRan(out, TESTS);
  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': the guarded kill forwarded its precondition and surfaced the ' +
      'Agent\'s conflict without removing the Session from the registry; an offline Agent was ' +
      'refused as unavailable; the legacy name-only command carried no precondition and kept its ' +
      'unclassified reply',
  });
  return 'The Server keeps the guarded refusal typed and outcome-indeterminate and leaves legacy name-only consumers unchanged';
});
