'use strict';
// #3704 SC-03: old real Server/Agent/Standalone behavior must remain working.
const {run, targetSha, crateTests, assertRan, isolatedTmuxEnv} = require('../../../shared/mcp-cases.cjs');

run(({evidence}) => {
  const sha = targetSha();
  const env = isolatedTmuxEnv('nession-3704-sc03');
  const agent = crateTests('nession-agent', ['--test', 'integration', 'mcp::agent_mcp_serves_local_tools_and_reports_a_missing_server'], 900000, env);
  assertRan(agent, ['mcp::agent_mcp_serves_local_tools_and_reports_a_missing_server']);
  const server = crateTests('nession-server', ['--test', 'integration', 'mcp::embedded_mcp_node_tools_route_to_the_named_agent'], 900000, env);
  assertRan(server, ['mcp::embedded_mcp_node_tools_route_to_the_named_agent']);
  const standalone = crateTests('nession-mcp', ['--test', 'integration', 'standalone::standalone_routes_agent_session_tools_through_the_server'], 900000, env);
  assertRan(standalone, ['standalone::standalone_routes_agent_session_tools_through_the_server']);
  const direct = crateTests('nession-mcp', ['--test', 'integration', 'standalone::standalone_direct_agent_mode_uses_the_real_agent_tmux'], 900000, env);
  assertRan(direct, ['standalone::standalone_direct_agent_mode_uses_the_real_agent_tmux']);
  evidence.push({
    type: 'runtime',
    value: 'exact staging ' + sha + ': Agent-embedded local tmux CRUD, Server-embedded broker routing, Standalone canonical Server routing and explicit direct-Agent mode all execute their original real Session paths',
  });
  return 'Session CRUD routing retains Agent authority and works in all four hosting routes';
});
