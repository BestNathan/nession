'use strict';
// #4081 SC-02: after one create with initial work context through each hosting
// mode, Get and the list summary on the returned incarnation report the same
// normalized context immediately — no separate AI update call.
const { run, targetSha, crateTests, assertRan, isolatedTmuxEnv } =
  require('../../../shared/mcp-cases.cjs');

const TEST = 'standalone::session_metadata_creation_is_equivalent_across_hosts';

run(({ evidence }) => {
  const sha = targetSha();
  const out = crateTests(
    'nession-mcp',
    ['--test', 'integration', TEST],
    300000,
    isolatedTmuxEnv('nession-4081-sc02-hosts'),
  );
  assertRan(out, [TEST]);
  evidence.push({
    type: 'runtime',
    value:
      'nession-mcp at exact SHA ' + sha + ': immediately after one create with ' +
      'initial title/description/tags, Get and the list summary reported the same ' +
      'normalized revision-1 context and durable instance identity on every host',
  });
  return 'Immediate Get and list-summary readback observe the committed initial context';
});
