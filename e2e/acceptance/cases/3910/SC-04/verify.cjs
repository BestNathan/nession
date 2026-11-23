'use strict';
// #3910 SC-04: Project-scoped MCP Session listing returns only Sessions whose
// current authoritative association matches, across Agents, with an optional
// Agent filter and truthful force/stale behavior. Web reassociation changes
// both MCP projections without touching the Agent Session runtime.
const {
  run, targetSha, crateTests, assertRan, isolatedTmuxEnv,
} = require('../../../shared/mcp-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const env = isolatedTmuxEnv('nession-3910-sc04');

  const unit = crateTests(
    'nession-mcp',
    ['--lib', 'tools::nession_server_project_session_list::tests::'],
    600_000,
    env,
  );
  assertRan(unit, [
    'it_returns_only_currently_associated_sessions',
    'it_forwards_the_agent_filter_and_force_refresh',
    'stale_agents_remain_truthful_on_an_empty_or_incomplete_view',
  ]);

  const runtime = crateTests(
    'nession-mcp',
    [
      '--test',
      'integration',
      'standalone::project_context_sessions_use_server_association_and_real_agent_runtime',
    ],
    900_000,
    env,
  );
  assertRan(runtime, [
    'standalone::project_context_sessions_use_server_association_and_real_agent_runtime',
  ]);

  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': Project-scoped listing returned only associated Sessions; a Web server.session.project.set correlated, changed the Project view and the Agent Session projection, and the Agent tmux Session kept the same instance identity and live runtime',
  });
  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': the Tool forwards agent_id and force to the Server query and preserves stale_agents, so an incomplete forced view is not presented as complete-but-empty',
  });
  return 'Project-scoped Session listing is a truthful Server view across Agents and follows Web reassociation without an Agent runtime change';
});
