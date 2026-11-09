'use strict';
// #3082 SC-01: a Project-created Session persists an explicit membership,
// exposes the same project_id through create/list/detail, and legacy or
// ordinary Sessions remain valid without one.
const { run, targetSha, crateTests, assertRan } = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();

  const protocol = crateTests('nession-protocol', ['contracts::session::tests::'], 300_000);
  assertRan(protocol, [
    'test_client_session_create_response_carries_project_membership',
    'test_session_project_binding_payload_removes_with_null_and_carries_expected_revision',
  ]);

  const create = crateTests('nession-server', ['--lib', 'server_session_create_v1::'], 300_000);
  assertRan(create, [
    'project_session_create_uses_the_declared_existing_location',
    'legacy_session_create_without_a_project_is_unchanged',
  ]);

  const binding = crateTests('nession-server', ['--lib', 'server_session_project_v1::'], 300_000);
  assertRan(binding, [
    'association_round_trips_and_projects_through_session_list',
    'association_is_authenticated_and_validates_entities',
  ]);

  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': a Project-aware create committed session_project_bindings ' +
      'and returned project_id; the same id was projected through server.session.list; an ' +
      'explicit association round-tripped with revision; a legacy create reported no ' +
      'project_id and wrote no membership (protocol + server handler tests)',
  });
  return 'A Project-created Session persists and exposes its project_id through create and list; legacy and ordinary Sessions remain valid without a Project';
});
