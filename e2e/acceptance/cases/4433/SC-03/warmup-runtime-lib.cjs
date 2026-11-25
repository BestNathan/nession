'use strict';
// #4433 SC-03 compile warmup for the nession-runtime lib test binary.
//
// The non-waiting lane-admission proof runs inside the runtime's own lib test
// binary. Linking it here keeps that proof verifier independent of the compile
// inside its 120 s budget. A compile proves no criterion by itself.
const {
  run,
  targetSha,
  crateTests,
  isolatedTmuxEnv,
} = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  crateTests(
    'nession-runtime',
    ['--lib', '--no-run'],
    110_000,
    isolatedTmuxEnv('nession-4433-sc03-runtime-lib-warmup'),
  );
  evidence.push({
    type: 'runtime',
    value: sha + ': compiled the nession-runtime lib test binary that carries the non-waiting admission test',
  });
  return 'compiled the nession-runtime lib test binary for the non-waiting admission test';
});
