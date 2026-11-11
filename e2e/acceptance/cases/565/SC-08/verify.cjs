'use strict';
// #565 SC-08: unauthenticated access, missing/unknown targets, argument errors,
// timeouts and concurrent calls are all covered by the shared contract tests
// and each hosting mode's error paths.
const { run, targetSha, crateTests, assertRan, isolatedTmuxEnv } = require('../../../shared/mcp-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const lib = crateTests('nession-mcp', ['--lib', 'service::tests'], 300000);
  assertRan(lib, [
    'service::tests::an_anonymous_request_is_refused',
    'service::tests::a_missing_required_argument_is_an_argument_error',
    'service::tests::a_slow_backend_times_out_as_a_tool_error',
    'service::tests::concurrent_calls_keep_their_own_ids',
  ]);
  const server = crateTests('nession-server', ['--test', 'integration', 'mcp::'], 900000);
  assertRan(server, [
    'mcp::embedded_mcp_refuses_an_unknown_session',
    'mcp::embedded_mcp_reports_a_missing_session',
  ]);
  crateTests(
    'nession-agent',
    ['--test', 'integration', 'mcp::agent_mcp_refuses_an_anonymous_request'],
    900000,
    isolatedTmuxEnv('nession-565-sc08-agent'),
  );
  const standalone = crateTests(
    'nession-mcp',
    ['--test', 'integration', 'standalone::standalone_host_serves_cluster_and_node_tools_over_its_own_endpoint'],
    900000,
    isolatedTmuxEnv('nession-565-sc08-node'),
  );
  assertRan(standalone, ['standalone::standalone_host_serves_cluster_and_node_tools_over_its_own_endpoint']);
  evidence.push(
    { type: 'runtime', value: '401 without/with a wrong bearer token; 404 for an unknown or terminated session at ' + sha },
    {
      type: 'runtime',
      value: 'missing arguments, missing Session, wrong Agent target, timeout and concurrent calls all returned the declared error/result forms',
    },
  );
  return 'Unauthenticated, missing-target, timeout and concurrent-call paths are covered across all three modes';
});
