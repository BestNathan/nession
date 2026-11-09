'use strict';
// #565 SC-05: Standalone, Agent embedded and Server embedded serve one catalog
// with identical tool definitions.
const { run, targetSha, crateTests, assertRan, isolatedTmuxEnv } = require('../../../shared/mcp-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const out = crateTests(
    'nession-mcp',
    ['--test', 'integration', 'standalone::all_three_hosts_share_one_tool_catalog'],
    900000,
    isolatedTmuxEnv('nession-565-sc05'),
  );
  assertRan(out, ['standalone::all_three_hosts_share_one_tool_catalog']);
  evidence.push({
    type: 'runtime',
    value: 'the three live /mcp endpoints returned byte-identical tools/list definitions at ' + sha,
  });
  return 'All three hosting modes serve the same tool names, descriptions and input schemas';
});
