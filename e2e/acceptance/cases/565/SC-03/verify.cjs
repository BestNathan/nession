'use strict';
// #565 SC-03: both embedders mount /mcp on their existing listener and serve
// initialization, discovery and real reads/writes.
const { run, targetSha, crateTests, assertRan } = require('../../../shared/mcp-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const server = crateTests('nession-server', ['--test', 'integration', 'mcp::'], 900000);
  assertRan(server, [
    'mcp::embedded_mcp_authenticates_and_lists_the_shared_catalog',
    'mcp::embedded_mcp_answers_cluster_reads_from_the_server',
    'mcp::embedded_mcp_node_tools_route_to_the_named_agent',
  ]);
  const agent = crateTests('nession-agent', ['--test', 'integration', 'mcp::'], 900000);
  assertRan(agent, [
    'mcp::agent_mcp_serves_local_tools_and_reports_a_missing_server',
    'mcp::agent_mcp_refuses_an_anonymous_request',
  ]);
  evidence.push(
    { type: 'runtime', value: 'Server embedded: initialize, tools/list, cluster read and routed node write passed at ' + sha },
    { type: 'runtime', value: 'Agent embedded: initialize, tools/list and real tmux create/list/kill passed at ' + sha },
  );
  return 'Agent and Server each enable /mcp independently and complete initialization, discovery and real tool calls';
});
