'use strict';
// #4302 SC-02 compile warmup for the nession-mcp lib test binary.
const { run, targetSha, crateTests } = require('../../../shared/mcp-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  crateTests('nession-mcp', ['--lib', '--no-run'], 110000);
  evidence.push({
    type: 'runtime',
    value: 'exact SHA ' + sha + ': compiled the nession-mcp lib test binary for the AI-facing kill Tool',
  });
  return 'compiled the nession-mcp lib test binary for the AI-facing kill Tool';
});
