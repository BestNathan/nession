'use strict';
// #4302 SC-02 compile warmup for the nession-agent integration test binary.
const { run, targetSha, crateTests, isolatedTmuxEnv } = require('../../../shared/mcp-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  crateTests('nession-agent', ['--test', 'integration', '--no-run'], 110000,
    isolatedTmuxEnv('nession-4302-sc02-agent-integration-warmup'));
  evidence.push({
    type: 'runtime',
    value: 'exact SHA ' + sha + ': compiled the nession-agent integration test binary for the Agent-embedded Tool proof',
  });
  return 'compiled the nession-agent integration test binary for the Agent-embedded Tool proof';
});
