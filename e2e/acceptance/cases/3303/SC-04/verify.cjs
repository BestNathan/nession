'use strict';
// #3303 SC-04: on a supported real Linux FUSE runner, an already verified
// EROFS image mounts read-only into an existing Sandbox composition and
// unmounts with owned-resource cleanup; digest mismatch, missing helpers/
// capabilities and invalid source roots fail closed without Native fallback.
// The Sandbox retains root composition and execution authority.
//
// The mount/unmount primitive lives in `nession-erofs::mount`; the end-to-end
// composition proof reuses the #3024 Linux runtime Case because the Sandbox
// still owns authorization, ordering, overlay composition and teardown.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run, checked, crateTests, assertRan } = require('../../../shared/control-mode-cases.cjs');
const {
  probeCapabilities, runLinuxRuntimeTest, runtimeEvidence, pending, capabilityLine,
} = require('../../../shared/sandbox-cases.cjs');

try {
  checked('sudo', ['apt-get', 'update', '-qq'], 120000);
  checked(
    'sudo',
    ['apt-get', 'install', '-y', '-qq', 'erofs-utils', 'erofsfuse', 'fuse3', 'fuse-overlayfs'],
    300000,
  );
} catch (error) {
  console.error('could not install EROFS helpers: ' + error.message);
}

const imageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-erofs-accept-'));
process.env.SANDBOX_EROFS_IMAGE_ROOT = imageRoot;
const capabilities = probeCapabilities();
if (!capabilities.backend) {
  pending('No usable Linux Sandbox backend on this runner: ' + capabilities.unavailable, [
    { type: 'blocked', value: capabilityLine(capabilities) },
  ]);
} else if (!capabilities.erofs || !capabilities.erofs_overlay) {
  pending(
    'The runner cannot mount prepared EROFS images or merge a writable workspace overlay',
    [{ type: 'blocked', value: capabilityLine(capabilities) }],
  );
} else {
  run(({ evidence }) => {
    const primitive = crateTests(
      'nession-erofs',
      ['--features', 'mount', '--lib', 'mount::tests'],
      600000,
    );
    assertRan(primitive, [
      'mount::tests::a_missing_erofsfuse_fails_closed',
      'mount::tests::a_missing_fusermount_fails_closed',
      'mount::tests::a_path_without_execute_permission_is_not_a_helper',
      'mount::tests::an_unmounted_directory_is_not_a_mount',
    ]);
    const sandbox = crateTests('nession-sandbox', ['--lib', 'linux::erofs::tests'], 600000);
    assertRan(sandbox, [
      'linux::erofs::tests::a_missing_erofsfuse_fails_closed',
      'linux::erofs::tests::a_missing_fusermount_fails_closed',
      'linux::erofs::tests::a_digest_mismatch_is_refused_before_mounting',
      'linux::erofs::tests::a_source_outside_the_authorized_root_is_refused_before_mounting',
    ]);
    const closures = crateTests('nession-sandbox', ['--lib', 'capabilities::tests'], 600000);
    assertRan(closures, [
      'capabilities::tests::a_linux_composition_without_erofs_support_is_refused',
      'capabilities::tests::a_linux_workspace_image_without_overlay_support_is_refused',
    ]);

    const output = runLinuxRuntimeTest(
      'two_compositions_share_images_and_release_only_their_own_mounts',
    );
    const facts = runtimeEvidence(output);
    assert.equal(facts.detached_pane_survived, true);
    assert.equal(facts.shared_images_remained_mounted, true);
    assert.ok(facts.first_mounts_released >= 3);
    assert.ok(facts.second_mounts_released >= 3);
    evidence.push(
      {
        type: 'runtime',
        value:
          'exact runner capability receipt: ' + capabilityLine(capabilities),
      },
      {
        type: 'runtime',
        value:
          'executions ' + facts.first_execution + ' and ' + facts.second_execution +
          ' mounted the same Base/Project/toolchain images read-only through the extracted ' +
          'primitive; cleaning the first unmounted only its ' + facts.first_mounts_released +
          ' mounts and left the second\'s ' + facts.second_mounts_released + ' live',
      },
      {
        type: 'runtime',
        value:
          'missing erofsfuse/fusermount, a non-executable helper, a digest mismatch, a source ' +
          'outside the authorized image root and unsupported EROFS/overlay capabilities all ' +
          'failed closed; no Native fallback substituted',
      },
    );
    return (
      'A verified EROFS image mounts read-only into an existing Sandbox composition and ' +
      'cleans up only owned mounts, while missing helpers, wrong bytes, unauthorized sources ' +
      'and unsupported capabilities fail closed without Native fallback'
    );
  });
}
