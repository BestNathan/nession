'use strict';
// #3407 SC-02 (Server half): explicit managed > matching Project Location >
// Session-name auto, with wrong-Agent/missing/offline selections refused and
// no hidden fallback.
const { run, targetSha, crateTests, assertRan } = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const server = crateTests('nession-server', [
    '--lib',
    'server::handler::tests::server_session_sandbox_v1::',
  ]);
  assertRan(server, [
    'server::handler::tests::server_session_sandbox_v1::preflight_auto_selects_the_matching_project_location',
    'server::handler::tests::server_session_sandbox_v1::preflight_managed_selection_overrides_the_project_location',
    'server::handler::tests::server_session_sandbox_v1::preflight_explicit_project_location_on_another_agent_fails_closed',
    'server::handler::tests::server_session_sandbox_v1::preflight_refuses_an_offline_agent_before_workspace_resolution',
    'server::handler::tests::server_session_sandbox_v1::enter_forwards_the_resolved_project_location_and_grants',
  ]);
  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': an explicit managed selection outranked the Project Location; ' +
      'auto selected the matching Project Location on the target Agent; a location declared only ' +
      'on another Agent, and an offline Agent were refused with actionable states; Enter ' +
      'forwarded only the resolved path and no lower grant for an external Project Location',
  });
  return 'Server-side Workspace selection precedence and fail-closed routing are proven';
});
