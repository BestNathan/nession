'use strict';
// #3141 SC-05: the native write surface cannot be redirected. Hierarchy and
// lifecycle interfaces, path traversal, absolute paths and symlinks are
// rejected by the shared naming owner and the basename-only O_NOFOLLOW writer;
// cleanup only removes a direct child of the Nession-owned root.
const assert = require('node:assert/strict');
const {
  run,
  crateTests,
  assertRan,
} = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  assert.equal(process.platform, 'linux', 'the native write boundary is Linux-specific');

  const naming = crateTests(
    'nession-sandbox',
    ['--lib', 'cgroup_file::tests::'],
    600_000,
  );
  assertRan(naming, [
    'declarative_controller_files_are_accepted_without_an_allowlist',
    'lifecycle_status_and_command_interfaces_are_never_editable',
    'traversal_and_escaping_names_are_rejected',
  ]);

  const writer = crateTests(
    'nession-sandbox',
    ['--lib', 'linux::cgroup::tests::'],
    600_000,
  );
  assertRan(writer, [
    'native_writes_refuse_traversal_lifecycle_names_and_symlinks',
    'cleanup_refuses_a_path_that_is_not_a_direct_child_of_the_root',
  ]);

  const compile = crateTests(
    'nession-sandbox',
    ['--lib', 'policy::tests::native_cgroup_values_pass_through_without_application_parsers'],
    600_000,
  );
  assertRan(compile, ['native_cgroup_values_pass_through_without_application_parsers']);

  evidence.push(
    {
      type: 'runtime',
      value:
        'cgroup.procs/cgroup.threads/cgroup.kill/cgroup.freeze/cgroup.subtree_control and read-only state were rejected as policy keys',
    },
    {
      type: 'runtime',
      value:
        'path traversal, absolute paths and a symlinked control file were refused; the symlink target stayed unchanged',
    },
    {
      type: 'runtime',
      value:
        'cleanup refused paths that were not direct children of the Nession-owned cgroup root',
    },
    {
      type: 'runtime',
      value:
        'compile rejected lifecycle keys before any host resource was created; the Agent session/context authorization is unchanged and remains the outer boundary',
    },
  );
  return 'The native cgroup write surface cannot escape its owned child, address a lifecycle interface, or follow a symlink; cleanup is root-scoped';
});
