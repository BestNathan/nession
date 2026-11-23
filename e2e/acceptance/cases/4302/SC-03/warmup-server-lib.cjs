'use strict';
// #4302 SC-03 compile warmup for the nession-server lib test binary.
const { run, targetSha, crateTests } = require('../../../shared/mcp-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  crateTests('nession-server', ['--lib', '--no-run'], 110000);
  evidence.push({
    type: 'runtime',
    value: 'exact SHA ' + sha + ': compiled the nession-server lib test binary for the kill reply classification',
  });
  return 'compiled the nession-server lib test binary for the kill reply classification';
});
