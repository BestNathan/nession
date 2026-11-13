'use strict';
// #3407 SC-03: reusable bytes outlive execution/Session; deletion is refused
// while leased or unsafe, and never follows a symlink or recreates a missing
// directory.
const { run, targetSha, crateTests, assertRan } = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const agent = crateTests('nession-agent', ['--lib', 'workspace_manager::tests::']);
  assertRan(agent, [
    'workspace_manager::tests::delete_refuses_a_lease_and_removes_the_unleased_workspace',
    'workspace_manager::tests::delete_refuses_a_symlinked_workspace_path',
    'workspace_manager::tests::a_missing_directory_is_missing_and_never_recreated',
    'workspace_manager::tests::restart_reuses_the_same_id_and_bytes',
  ]);
  const server = crateTests('nession-server', [
    '--lib',
    'server::handler::tests::server_workspace_v1',
  ]);
  assertRan(server, [
    'server::handler::tests::server_workspace_v1::workspace_delete_relays_the_agent_refusal',
    'server::handler::tests::server_workspace_v1::workspace_delete_refuses_an_invalid_id_before_routing',
  ]);
  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': managed bytes survived a registry reopen; deletion was refused while ' +
      'an RW lease existed and for a symlinked path, then removed only the unleased owned ' +
      'directory; a missing directory stayed missing and was never recreated; the Server refused ' +
      'an invalid id before routing and relayed an in-use refusal',
  });
  return 'Managed Workspace lifetime, safe deletion and missing-directory honesty are proven';
});
