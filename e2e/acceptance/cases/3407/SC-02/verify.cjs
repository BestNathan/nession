'use strict';
// #3407 SC-02: explicit selection > matching Project Existing Location >
// Session-name managed allocation, with fail-closed wrong-Agent/missing/
// offline/unauthorized states and no hidden fallback. The executable proof is
// the exact-SHA Agent resolution and Server routing tests.
const { run, targetSha, crateTests, assertRan } = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();

  const agent = crateTests('nession-agent', ['--lib', 'tmux::sandbox_context::tests::']);
  assertRan(agent, [
    'tmux::sandbox_context::tests::a_project_location_must_be_a_real_canonical_directory',
    'tmux::sandbox_context::tests::a_symlinked_project_location_is_refused',
    'tmux::sandbox_context::tests::a_managed_workspace_pins_its_project_lower_across_resolution',
  ]);

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
      'on another Agent, a missing/non-canonical/symlinked directory and an offline Agent were ' +
      'refused with actionable field/error states; Enter forwarded only the resolved path and no ' +
      'lower grant for an external Project Location',
  });
  return 'Workspace selection precedence and fail-closed Project Location resolution are proven';
});
