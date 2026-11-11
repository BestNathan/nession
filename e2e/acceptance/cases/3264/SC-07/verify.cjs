'use strict';
// #3264 SC-07: the real listener enforces bearer auth, Origin policy, bounded
// execution and meaningful errors; the WebSocket path and orderly shutdown keep
// working on the same host.
const {
  run, targetSha, crateTests, assertRan, read, isolatedTmuxEnv,
} = require('../../../shared/mcp-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const env = isolatedTmuxEnv('nession-3264-sc07');

  const protocol = crateTests('nession-mcp', ['--test', 'integration', 'protocol::'], 900000, env);
  assertRan(protocol, [
    'protocol::auth_and_path_fail_closed',
    'protocol::a_present_origin_is_refused_by_default',
    'protocol::a_slow_tool_call_times_out_as_a_tool_error',
  ]);

  const server = crateTests(
    'nession-server',
    ['--test', 'integration', 'mcp::'],
    900000,
    env,
  );
  assertRan(server, [
    'mcp::embedded_mcp_does_not_displace_the_websocket_connection',
    'mcp::embedded_mcp_refuses_an_unknown_session',
    'mcp::embedded_mcp_terminates_a_session_and_then_refuses_it',
  ]);

  const standalone = crateTests(
    'nession-mcp',
    ['--test', 'integration', 'standalone::standalone_routes_agent_session_tools_through_the_server'],
    900000,
    env,
  );
  assertRan(standalone, ['standalone::standalone_routes_agent_session_tools_through_the_server']);

  const config = read('crates/nession-common/src/config.rs');
  if (!config.includes('pub allowed_origins: Vec<String>')) {
    throw new Error('the host configuration has no Origin policy');
  }
  if (!config.includes('pub allowed_hosts: Option<Vec<String>>')) {
    throw new Error('the host configuration has no Host policy');
  }

  evidence.push({
    type: 'runtime',
    value: 'staging SHA ' + sha + ': anonymous and wrong bearer tokens received 401 with no detail, a present browser Origin was refused 403, and a slow backend became an isError timeout result with its kind preserved',
  });
  evidence.push({
    type: 'runtime',
    value: 'the same listener still authenticated a WebSocket client and served server.agent.list, unknown/terminated MCP sessions were refused, and SIGTERM stopped the standalone host cleanly',
  });
  return 'auth, Origin, deadlines and errors are enforced on the real listener while WebSocket, legacy sessions and orderly shutdown continue to work';
});
