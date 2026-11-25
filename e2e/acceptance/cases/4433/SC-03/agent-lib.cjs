'use strict';
// #4433 SC-03: the Agent central connection refuses work past its bound and
// answers the refused command, so the Server settles the waiter instead of
// letting it time out.
//
// The binary was linked by warmup-agent-lib.cjs, so this run is warm.
const {
  run,
  targetSha,
  assertRan,
  crateTests,
  isolatedTmuxEnv,
} = require('../../../shared/control-mode-cases.cjs');

const TESTS = [
  'connection::server_client::tests::the_central_connection_refuses_past_its_bound_and_drains',
];

run(({ evidence }) => {
  const sha = targetSha();
  const env = isolatedTmuxEnv('nession-4433-sc03-agent-lib');
  for (const test of TESTS) {
    assertRan(crateTests('nession-agent', ['--lib', test], 100_000, env), [test]);
  }
  evidence.push({
    type: 'runtime',
    value:
      sha +
      ': the Agent central connection refused a command past its bound and answered it, so the ' +
      'Server settled the pending waiter instead of timing out',
  });
  return 'The Agent central connection refuses past its bound explicitly and settles the refused command instead of parking it';
});
