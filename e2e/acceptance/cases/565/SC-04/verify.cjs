'use strict';
// #565 SC-04: the Server exposes the full cluster tool set without requiring
// any Agent to enable MCP.
const { run, targetSha, crateTests, assertRan } = require('../../../shared/mcp-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const out = crateTests('nession-server', ['--test', 'integration', 'mcp::'], 900000);
  assertRan(out, [
    'mcp::embedded_mcp_authenticates_and_lists_the_shared_catalog',
    'mcp::embedded_mcp_answers_cluster_reads_from_the_server',
    'mcp::embedded_mcp_node_tools_route_to_the_named_agent',
    'mcp::embedded_mcp_reports_a_missing_session',
  ]);
  evidence.push(
    { type: 'runtime', value: 'the Server catalog test asserts all nine nession_server_* names at ' + sha },
    { type: 'runtime', value: 'cluster reads/writes answered with no Agent MCP endpoint enabled' },
  );
  return 'The Server serves every cluster tool from its own registry/routing without an Agent MCP endpoint';
});
