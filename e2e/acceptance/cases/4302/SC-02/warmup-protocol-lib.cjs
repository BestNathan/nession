'use strict';
// #4302 SC-02 compile warmup for the protocol contract test binary.
const { run, targetSha, crateTests } = require('../../../shared/mcp-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  crateTests('nession-protocol', ['--lib', '--no-run'], 110000);
  evidence.push({
    type: 'runtime',
    value: 'exact SHA ' + sha + ': compiled the nession-protocol lib test binary for the kill contract',
  });
  return 'compiled the nession-protocol lib test binary for the kill contract';
});
