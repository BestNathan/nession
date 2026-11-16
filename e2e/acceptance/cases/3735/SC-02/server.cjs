'use strict';
// #3735 SC-02: the Server-embedded MCP host answers through its real registry
// and routes Agent-owned Tools to the explicitly named Agent, returning the
// same structured reply as its text content.
const { run, targetSha, crateTests, assertRan, isolatedTmuxEnv } =
  require('../../../shared/mcp-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const out = crateTests(
    'nession-server',
    ['--test', 'integration', 'mcp::'],
    110000,
    isolatedTmuxEnv('nession-3735-sc02-server'),
  );
  assertRan(out, [
    'mcp::embedded_mcp_answers_server_owned_discovery_from_the_registry',
    'mcp::embedded_mcp_node_tools_route_to_the_named_agent',
  ]);
  evidence.push(
    {
      type: 'runtime',
      value:
        'nession-server embedded MCP at exact SHA ' +
        sha +
        ' returned structuredContent equal to its text for discovery and Agent-routed calls',
    },
  );
  return 'The Server-embedded MCP host returns conformant structured success replies';
});
