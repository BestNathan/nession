'use strict';
// #4302 SC-01 compile warmup. The Acceptance driver kills every verifier
// process 120 s after spawn, so the owner test binary is linked here and the
// proof verifier that follows runs against a warm target cache. A compile
// proves no criterion by itself.
const { run, targetSha, crateTests, isolatedTmuxEnv } = require('../../../shared/mcp-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  crateTests('nession-agent', ['--lib', '--no-run'], 110000,
    isolatedTmuxEnv('nession-4302-sc01-lib-warmup'));
  evidence.push({
    type: 'runtime',
    value: 'exact SHA ' + sha + ': compiled the nession-agent lib test binary for the guarded-kill owner suite',
  });
  return 'compiled the nession-agent lib test binary for the guarded-kill owner suite';
});
