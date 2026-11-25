'use strict';
// #4433 SC-03 compile warmup for the nession-agent lib test binary.
//
// The central-connection proof runs inside the Agent's own lib test binary.
// Linking it here keeps that proof verifier's own 120 s budget for the test
// itself. A compile proves no criterion by itself.
const {
  run,
  targetSha,
  crateTests,
  isolatedTmuxEnv,
} = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  crateTests(
    'nession-agent',
    ['--lib', '--no-run'],
    110_000,
    isolatedTmuxEnv('nession-4433-sc03-agent-lib-warmup'),
  );
  evidence.push({
    type: 'runtime',
    value:
      sha +
      ': compiled the nession-agent lib test binary that carries the central-connection refusal test',
  });
  return 'compiled the nession-agent lib test binary for the central-connection refusal test';
});
