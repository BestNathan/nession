'use strict';
// #3021 SC-01: a Project with only a name/identity persists and is readable
// through the authenticated versioned API, and invalid URL/ref/path/identity
// data is rejected deterministically with no partial write.
const {
  run, targetSha, crateTests, assertRan,
} = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();

  const protocol = crateTests(
    'nession-protocol',
    ['contracts::project::tests::'],
    300_000,
  );
  assertRan(protocol, [
    'a_name_only_project_is_valid',
    'invalid_repository_urls_are_rejected_deterministically',
    'invalid_source_refs_are_rejected_deterministically',
    'relative_parent_and_control_locations_are_rejected',
    'project_identities_match_the_server_minted_shape',
  ]);

  const server = crateTests(
    'nession-server',
    ['--lib', 'server_project_'],
    300_000,
  );
  assertRan(server, [
    'project_create_requires_auth',
    'project_create_with_name_only_persists',
    'project_create_rejects_invalid_data_deterministically',
    'project_get_rejects_a_malformed_identity',
    'project_update_replaces_the_whole_declaration_and_preserves_identity',
    'project_delete_removes_only_the_declaration',
  ]);

  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': a name-only Project was created, read, renamed and deleted ' +
      'through the authenticated server.project.* units; empty name, file:// URL, invalid ' +
      'ref, relative path and malformed identity were each refused with their deterministic ' +
      'message and persisted nothing (protocol validation + server handler tests)',
  });
  return 'A name-only Project round-trips through the authorized versioned API and invalid URL/ref/path/identity data is rejected deterministically';
});
