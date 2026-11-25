'use strict';
// #4433 SC-03: a full query lane refuses without waiting, so the reader is
// never parked behind saturated business work.
//
// The binary was linked by warmup-runtime-lib.cjs, so this run is warm.
const {
  run,
  targetSha,
  assertRan,
  crateTests,
  isolatedTmuxEnv,
} = require('../../../shared/control-mode-cases.cjs');

const TESTS = ['lane::tests::a_full_query_lane_refuses_without_waiting'];

run(({ evidence }) => {
  const sha = targetSha();
  const env = isolatedTmuxEnv('nession-4433-sc03-runtime-lib');
  for (const test of TESTS) {
    assertRan(crateTests('nession-runtime', ['--lib', test], 100_000, env), [test]);
  }
  evidence.push({
    type: 'runtime',
    value: sha + ': a full query lane refused explicitly instead of parking the reader on a business permit',
  });
  return 'Runtime admission refuses saturated query lanes without waiting, so reader progress never depends on business permits';
});
