'use strict';
// #4302 SC-02 compile warmup for the nession-mcp integration test binary.
const { run, targetSha, crateTests, isolatedTmuxEnv } = require('../../../shared/mcp-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  crateTests('nession-mcp', ['--test', 'integration', '--no-run'], 110000,
    isolatedTmuxEnv('nession-4302-sc02-mcp-integration-warmup'));
  evidence.push({
    type: 'runtime',
    value: 'exact SHA ' + sha + ': compiled the nession-mcp integration test binary for the four-host equivalence proof',
  });
  return 'compiled the nession-mcp integration test binary for the four-host equivalence proof';
});
