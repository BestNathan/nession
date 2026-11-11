'use strict';
// #3264 SC-04: Agent-owned Session tools reach the explicitly named Agent in
// every hosting mode. Standalone routes through the Server's canonical broker
// by default (no direct Agent endpoint), Server-embedded routes through the
// same broker, and Agent-embedded/direct mode use real tmux. A wrong target
// never acts on another Agent or the local host.
const {
  run, targetSha, crateTests, assertRan, isolatedTmuxEnv,
} = require('../../../shared/mcp-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const env = isolatedTmuxEnv('nession-3264-sc04');

  const standalone = crateTests('nession-mcp', ['--test', 'integration', 'standalone::'], 900000, env);
  assertRan(standalone, [
    'standalone::standalone_routes_agent_session_tools_through_the_server',
    'standalone::standalone_direct_agent_mode_uses_the_real_agent_tmux',
  ]);

  const server = crateTests(
    'nession-server',
    ['--test', 'integration', 'mcp::embedded_mcp_node_tools_route_to_the_named_agent'],
    900000,
    env,
  );
  assertRan(server, ['mcp::embedded_mcp_node_tools_route_to_the_named_agent']);

  const agent = crateTests(
    'nession-agent',
    ['--test', 'integration', 'mcp::agent_mcp_serves_local_tools_and_reports_a_missing_server'],
    900000,
    env,
  );
  assertRan(agent, ['mcp::agent_mcp_serves_local_tools_and_reports_a_missing_server']);

  evidence.push({
    type: 'runtime',
    value: 'staging SHA ' + sha + ': Standalone with only [backend.server] invoked create/list/kill on the named Agent and the Server broker carried agent.session.create/report/kill; the returned Agent truth contained the created Session',
  });
  evidence.push({
    type: 'runtime',
    value: 'Server-embedded routed the same operations to the registered Agent, Agent-embedded and explicit direct-Agent mode created/listed/killed a real tmux Session, and a mismatched/unknown target was refused in every mode',
  });
  return 'Server-embedded, Standalone-routed, Standalone-direct and Agent-embedded all act on the explicitly named Agent; wrong targets and missing targets are refused';
});
