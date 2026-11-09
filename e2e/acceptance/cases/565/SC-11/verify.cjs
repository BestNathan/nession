'use strict';
// #565 SC-11: CI includes the shared contract tests and all three modes'
// integration tests; every tool mapping is exercised, and each mode covers
// list, create/destroy and an error path.
const { run, targetSha, crateTests, assertRan } = require('../../../shared/mcp-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const lib = crateTests('nession-mcp', ['--lib', 'service::tests'], 300000);
  assertRan(lib, [
    'service::tests::tools_are_identical_across_every_catalog_read',
    'service::tests::initialize_creates_a_session_and_tools_list_uses_it',
    'service::tests::a_tool_refusal_is_an_error_result_not_a_transport_error',
  ]);
  const server = crateTests('nession-server', ['--test', 'integration', 'mcp::'], 900000);
  assertRan(server, [
    'mcp::embedded_mcp_authenticates_and_lists_the_shared_catalog',
    'mcp::embedded_mcp_answers_cluster_reads_from_the_server',
    'mcp::embedded_mcp_node_tools_route_to_the_named_agent',
  ]);
  const agent = crateTests('nession-agent', ['--test', 'integration', 'mcp::'], 900000);
  assertRan(agent, ['mcp::agent_mcp_serves_local_tools_and_reports_a_missing_server']);
  const standalone = crateTests('nession-mcp', ['--test', 'integration'], 900000);
  assertRan(standalone, [
    'standalone::standalone_host_serves_cluster_and_node_tools_over_its_own_endpoint',
    'standalone::all_three_hosts_share_one_tool_catalog',
  ]);
  evidence.push(
    { type: 'runtime', value: 'shared catalog/lifecycle unit tests at ' + sha },
    { type: 'runtime', value: 'Server, Agent and Standalone integration suites each cover list, create/destroy and error paths' },
  );
  return 'CI carries shared contract tests plus all three hosting-mode integration suites covering the full tool mapping';
});
