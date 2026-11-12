'use strict';
// #3021 SC-03: an EROFS digest is a reference to globally shared content, not
// an owned artifact. Deleting a Project removes only its declaration: the
// user-owned Existing Location directory survives, a second Project's
// reference to the same digest survives, and no Session is cascaded.
const {
  run, targetSha, crateTests, assertRan,
} = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();

  const server = crateTests(
    'nession-server',
    ['--lib', 'server_project_delete_v1'],
    300_000,
  );
  assertRan(server, [
    'project_delete_removes_only_the_declaration',
    'project_delete_does_not_remove_globally_shared_image_content',
    'project_delete_does_not_cascade_to_sessions',
  ]);

  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': deleting a Project left its referenced real directory and file ' +
      'byte-identical, left a second Project still referencing the same sha256 digest, and ' +
      'left an unrelated Session present; only the declaration row disappeared ' +
      '(server.project.delete handler tests)',
  });
  return 'Deleting a Project cannot delete user-owned Existing Locations, shared EROFS content, or Sessions';
});
