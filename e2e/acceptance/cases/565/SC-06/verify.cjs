'use strict';
// #565 SC-06: local Session tools act on the explicitly named Agent and refuse
// a missing or mismatched target; no mode falls back to the MCP host.
const { run, targetSha, crateTests, assertRan } = require('../../../shared/mcp-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const server = crateTests(
    'nession-server',
    ['--test', 'integration', 'mcp::embedded_mcp_node_tools_route_to_the_named_agent'],
    900000,
  );
  assertRan(server, ['mcp::embedded_mcp_node_tools_route_to_the_named_agent']);
  const agent = crateTests(
    'nession-agent',
    ['--test', 'integration', 'mcp::agent_mcp_serves_local_tools_and_reports_a_missing_server'],
    900000,
  );
  assertRan(agent, ['mcp::agent_mcp_serves_local_tools_and_reports_a_missing_server']);
  const standalone = crateTests(
    'nession-mcp',
    ['--test', 'integration', 'standalone::standalone_host_serves_cluster_and_node_tools_over_its_own_endpoint'],
    900000,
  );
  assertRan(standalone, ['standalone::standalone_host_serves_cluster_and_node_tools_over_its_own_endpoint']);
  evidence.push(
    { type: 'runtime', value: 'Server embedded routes agent.session.* to the named Agent through the command broker at ' + sha },
    { type: 'runtime', value: 'Agent embedded refuses a different agent_id instead of acting locally' },
    { type: 'runtime', value: 'Standalone refuses an agent_id outside [backend.agent] and acts only on the configured node' },
  );
  return 'Agent tools always act on the explicitly named Agent, and every mode refuses a missing/mismatched target';
});
