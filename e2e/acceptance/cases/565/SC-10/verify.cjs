'use strict';
// #565 SC-10: embedded MCP shuts down with its host (Agent handle), and the
// standalone program exits on SIGTERM without destroying a host it does not own.
const { run, targetSha, crateTests, assertRan } = require('../../../shared/mcp-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const agent = crateTests('nession-agent', ['--test', 'integration', 'mcp::'], 900000);
  assertRan(agent, [
    'mcp::agent_mcp_serves_local_tools_and_reports_a_missing_server',
    'mcp::agent_mcp_refuses_an_anonymous_request',
  ]);
  const standalone = crateTests(
    'nession-mcp',
    ['--test', 'integration', 'standalone::standalone_host_serves_cluster_and_node_tools_over_its_own_endpoint'],
    900000,
  );
  assertRan(standalone, ['standalone::standalone_host_serves_cluster_and_node_tools_over_its_own_endpoint']);
  evidence.push(
    { type: 'runtime', value: 'Agent shutdown completed with the MCP listener and its connections at ' + sha },
    { type: 'runtime', value: 'the standalone binary exited cleanly on SIGTERM (the test asserts the exit status)' },
  );
  return 'Embedded MCP follows its host shutdown, and standalone MCP exits cleanly on SIGTERM';
});
