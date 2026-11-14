'use strict';
// #3407 SC-04 (Agent half): the managed composition keeps the Project source
// EROFS as its lower, an external Project Location refuses a lower, and the
// durable upper's lower digest is pinned across resolution.
const { run, targetSha, crateTests, assertRan } = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const agent = crateTests('nession-agent', [
    '--lib',
    'sandbox_images::workspace_override_tests::',
  ]);
  assertRan(agent, [
    'sandbox_images::workspace_override_tests::a_managed_workspace_keeps_the_project_erofs_lower',
    'sandbox_images::workspace_override_tests::a_project_location_is_external_and_refuses_a_lower',
  ]);
  const pin = crateTests('nession-agent', [
    '--lib',
    'workspace_manager::tests::a_lower_digest_is_pinned_for_the_durable_upper',
  ]);
  assertRan(pin, [
    'workspace_manager::tests::a_lower_digest_is_pinned_for_the_durable_upper',
  ]);
  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': the managed composition kept the Project source EROFS as ' +
      'its lower; an external Project Location with a lower was refused; a changed or ' +
      'missing lower was refused while the first lower stayed recorded across a registry reopen',
  });
  return 'The Agent-side managed lower contract and its refusals are proven';
});
