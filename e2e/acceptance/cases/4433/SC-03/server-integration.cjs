'use strict';
// #4433 SC-03: the Server client socket keeps control/response progress while a
// query lane is blocked, orders registration ahead of the state the Agent
// reports, and retains same-session FIFO across two connections.
//
// This verifier runs the Server leg only; the Agent P2P, Agent central and
// runtime lane legs are separate verifiers so each keeps its own 120 s driver
// budget. The binary was linked by warmup-server-integration.cjs, so this run
// is warm.
const {
  run,
  targetSha,
  assertRan,
  crateTests,
  isolatedTmuxEnv,
} = require('../../../shared/control-mode-cases.cjs');

const TESTS = [
  'websocket::registration_is_ordered_before_the_state_the_agent_reports',
  'websocket::a_mutation_is_not_held_behind_a_slow_query',
  'websocket::mutations_of_one_session_are_ordered_across_connections',
];

run(({ evidence }) => {
  const sha = targetSha();
  const env = isolatedTmuxEnv('nession-4433-sc03-server-integration');
  for (const test of TESTS) {
    assertRan(crateTests('nession-server', ['--test', 'integration', test], 100_000, env), [test]);
  }
  evidence.push({
    type: 'runtime',
    value:
      sha +
      ': the Server client socket ordered registration before dependent state, answered an ' +
      'independent mutation/probe behind a blocked slow query, and kept same-session FIFO ' +
      'across two connections',
  });
  return (
    'The Server client socket fences registration ahead of dependent state, does not park the ' +
    'reader behind business permits, and preserves same-session FIFO across connections'
  );
});
