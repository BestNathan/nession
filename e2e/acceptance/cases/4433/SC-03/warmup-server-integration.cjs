'use strict';
// #4433 SC-03 compile warmup for the nession-server integration binary.
//
// The Acceptance driver kills every verifier process 120 s after spawn, so
// compilation is a first-class part of the Case budget. The server integration
// binary carries the three WebSocket ingress tests; linking it here keeps the
// proof verifier that follows inside its own 120 s window against a warm
// target cache. A compile proves no criterion by itself.
const {
  run,
  targetSha,
  crateTests,
  isolatedTmuxEnv,
} = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  crateTests(
    'nession-server',
    ['--test', 'integration', '--no-run'],
    110_000,
    isolatedTmuxEnv('nession-4433-sc03-server-integration-warmup'),
  );
  evidence.push({
    type: 'runtime',
    value:
      sha +
      ': compiled the nession-server integration test binary that carries the WebSocket ingress ordering tests',
  });
  return 'compiled the nession-server integration test binary for the WebSocket ingress ordering tests';
});
