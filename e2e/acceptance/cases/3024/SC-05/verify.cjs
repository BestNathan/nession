'use strict';
// #3024 SC-05: an unsupported mount/filesystem/kernel or macOS combination
// refuses the launch with an explicit UnsupportedPolicy instead of falling back
// to Native. The executable proof is the exact-SHA capability validator: a
// composition without erofsfuse//dev/fuse is refused, a Project-image
// workspace without fuse-overlayfs is refused, and macOS rejects EROFS
// composition explicitly. The measured macOS probe itself is owned by #2681
// SC-06; this Case binds the fail-closed decision, never a fallback.
const { run, targetSha, checked, assertRan } = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const policy = checked(
    'cargo',
    ['test', '-p', 'nession-sandbox', '--lib', '--', '--nocapture'],
    600000,
  );
  assertRan(policy, [
    'capabilities::tests::a_linux_composition_without_erofs_support_is_refused',
    'capabilities::tests::a_linux_workspace_image_without_overlay_support_is_refused',
    'capabilities::tests::macos_rejects_composition_without_fallback',
  ]);
  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': a composition without erofsfuse//dev/fuse is refused; a Project-image ' +
      'workspace without fuse-overlayfs is refused; macOS returns UnsupportedPolicy for EROFS ' +
      'composition; no path degrades to Native',
  });
  return (
    'Unsupported mount/filesystem/kernel/macOS combinations reject the sandbox launch without ' +
    'silently falling back to Native or weakening #2681 isolation guarantees'
  );
});
