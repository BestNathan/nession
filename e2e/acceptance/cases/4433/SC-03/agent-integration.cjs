'use strict';
// #4433 SC-03: the Agent peer-to-peer socket admits two peers mutating one
// session in order, on one lane keyed by the session rather than by the
// connection.
//
// The test starts a real tmux session, so it gets a private socket and state
// home. The binary was linked by warmup-agent-integration.cjs, so this run is
// warm.
const {
  run,
  targetSha,
  assertRan,
  crateTests,
  isolatedTmuxEnv,
} = require('../../../shared/control-mode-cases.cjs');

const TESTS = ['server::two_peers_mutating_one_session_are_ordered'];

run(({ evidence }) => {
  const sha = targetSha();
  const env = isolatedTmuxEnv('nession-4433-sc03-agent-integration');
  for (const test of TESTS) {
    assertRan(crateTests('nession-agent', ['--test', 'integration', test], 100_000, env), [test]);
  }
  evidence.push({
    type: 'runtime',
    value:
      sha +
      ': the Agent P2P socket held the second peer behind the first peer\'s parked attach for ' +
      'the same session and admitted it once that work ended',
  });
  return 'The Agent P2P socket preserves same-session mutation ordering across two peers without a connection-scoped lane';
});
