'use strict';
// #4302 SC-01 compile warmup for the nession-agent integration binary. The
// 120 s driver cap applies to compilation too, so the binary that carries the
// controlled A→B interleaving test is linked in its own verifier process.
const { run, targetSha, crateTests, isolatedTmuxEnv } = require('../../../shared/mcp-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  crateTests('nession-agent', ['--test', 'integration', '--no-run'], 110000,
    isolatedTmuxEnv('nession-4302-sc01-integration-warmup'));
  evidence.push({
    type: 'runtime',
    value: 'exact SHA ' + sha + ': compiled the nession-agent integration test binary for the controlled-replacement test',
  });
  return 'compiled the nession-agent integration test binary for the controlled-replacement test';
});
