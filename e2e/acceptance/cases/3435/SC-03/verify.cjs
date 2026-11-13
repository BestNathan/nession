'use strict';
// #3435 SC-03: the Agent resolves/creates exactly one stable managed
// Workspace, leases it for the execution, binds its durable directory at
// /workspace instead of an execution scratch directory, refuses an
// unsupported Project-lower combination, and keeps the bytes across a
// restart while a leased Workspace cannot be deleted.
const {
  run,
  targetSha,
  cargoTests,
  assertRan,
} = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const manager = cargoTests(['--lib', 'workspace_manager::tests::'], 600000);
  assertRan(manager, [
    'workspace_manager::tests::concurrent_get_or_create_returns_one_stable_id',
    'workspace_manager::tests::restart_reuses_the_same_id_and_bytes',
    'workspace_manager::tests::a_missing_directory_is_missing_and_never_recreated',
    'workspace_manager::tests::delete_refuses_a_lease_and_removes_the_unleased_workspace',
    'workspace_manager::tests::delete_refuses_a_symlinked_workspace_path',
  ]);
  const attachment = cargoTests(
    ['--lib', 'sandbox_images::workspace_override_tests::'],
    600000,
  );
  assertRan(attachment, [
    'sandbox_images::workspace_override_tests::a_selected_managed_workspace_replaces_the_execution_scratch_dir',
    'sandbox_images::workspace_override_tests::a_managed_workspace_with_a_project_lower_is_refused',
  ]);
  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': concurrent get-or-create returned one stable id; a manager restart ' +
      'reused the same id and bytes; a missing directory stayed missing; delete was refused while ' +
      'leased and removed only an unleased workspace; a symlinked path was refused; the selected ' +
      'managed directory replaced the execution scratch write target and the unsupported ' +
      'Project-lower combination was refused',
  });
  return (
    'One stable managed Workspace is prepared and leased for /workspace; unsupported combinations ' +
    'fail closed and durable bytes survive while deletion requires no attachment'
  );
});
