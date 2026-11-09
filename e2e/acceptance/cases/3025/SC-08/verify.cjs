'use strict';
// #3025 SC-08: the Project API requires authentication for create/update/
// delete, a name-only declaration persists, and deletion removes only the
// declaration/references — never globally shared image content.
const {
  run, targetSha, crateTests, assertRan,
} = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();

  const server = crateTests(
    'nession-server',
    ['--lib', 'server_project_'],
    300_000,
  );
  assertRan(server, [
    'project_create_requires_auth',
    'project_create_with_name_only_persists',
    'project_create_rejects_invalid_data_deterministically',
    'project_update_requires_auth',
    'project_update_replaces_the_whole_declaration_and_preserves_identity',
    'project_delete_requires_auth',
    'project_delete_removes_only_the_declaration',
    'project_delete_does_not_remove_globally_shared_image_content',
  ]);

  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': unauthenticated create/update/delete were refused; a name-only ' +
      'Project persisted; invalid declarations were rejected without a partial write; an ' +
      'update preserved identity; delete removed only the Project declaration and left ' +
      'globally shared image content intact (server handler tests)',
  });
  return 'Project maintenance is authorized, name-only creation persists, and deletion removes only the declaration/references';
});
