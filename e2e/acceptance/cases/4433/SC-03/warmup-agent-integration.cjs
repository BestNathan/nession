'use strict';
// #4433 SC-03 compile warmup for the nession-agent integration binary.
//
// This binary is large and was never linked by the other WS runtime Cases, so
// the first verifier that runs it pays the whole compile inside the 120 s
// driver cap. Linking it in its own verifier keeps the P2P ordering proof
// below warm. A compile proves no criterion by itself.
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
    ['--test', 'integration', '--no-run'],
    110_000,
    isolatedTmuxEnv('nession-4433-sc03-agent-integration-warmup'),
  );
  evidence.push({
    type: 'runtime',
    value:
      sha +
      ': compiled the nession-agent integration test binary that carries the P2P same-session ordering test',
  });
  return 'compiled the nession-agent integration test binary for the P2P same-session ordering test';
});
