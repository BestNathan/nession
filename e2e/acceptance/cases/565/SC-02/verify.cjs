'use strict';
// #565 SC-02: the standalone host runs with no local Agent/Server process,
// connects the configured remote Server, and completes discovery plus
// Session create/kill through its own MCP endpoint.
const { run, targetSha, checked, crateTests, assertRan } = require('../../../shared/mcp-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  checked('cargo', ['build', '-p', 'nession-mcp', '--bin', 'nession-mcp'], 600000);
  const out = crateTests(
    'nession-mcp',
    ['--test', 'integration', 'standalone::standalone_host_serves_cluster_and_node_tools_over_its_own_endpoint'],
    900000,
  );
  assertRan(out, ['standalone::standalone_host_serves_cluster_and_node_tools_over_its_own_endpoint']);
  evidence.push(
    { type: 'runtime', value: 'nession-mcp standalone binary built at exact SHA ' + sha },
    { type: 'runtime', value: 'the binary served init/tools/list and remote Server list/create/kill over its own /mcp endpoint' },
  );
  return 'Standalone MCP reaches a remote Server and completes discovery and Session create/kill without local Server/Agent processes';
});
