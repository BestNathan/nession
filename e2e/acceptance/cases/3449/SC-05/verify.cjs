'use strict';
// #3449 SC-05: a composed Base/Workspace/Toolchain execution uses shared
// EROFS leases while keeping its writable overlay independent. Exit, detach,
// failed launch and reconciliation release only their own consumers, preserve
// other live Sessions and leave no unowned EROFS/Overlay mounts after the
// final verified cleanup.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run, checked } = require('../../../shared/control-mode-cases.cjs');
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
    const single = runtimeEvidence(
      runLinuxRuntimeTest('an_erofs_composition_runs_a_shell_with_a_writable_overlay_workspace'),
    );
    assert.equal(single.shell, 'ok');
    assert.equal(single.git, 'ok');
    assert.ok(single.shared_mounts >= 3);
    assert.ok(single.mounts_unmounted >= 4);

    const shared = runtimeEvidence(
      runLinuxRuntimeTest('two_compositions_share_images_and_release_only_their_own_mounts'),
    );
    assert.equal(shared.one_physical_mount_per_digest, true);
    assert.equal(shared.detached_pane_survived, true);
    assert.equal(shared.shared_images_remained_mounted, true);

    evidence.push(
      { type: 'runtime', value: 'a Base/Workspace/Toolchain composition ran a shell and Git over shared leases' },
      { type: 'runtime', value: 'each execution kept its own writable Overlay upper/work; shared read-only mounts were reused' },
      { type: 'runtime', value: 'detach, peer cleanup and final cleanup released only their own consumers and left no owned mounts' },
    );
    return (
      'Composed executions share read-only EROFS leases, keep independent writable overlays, ' +
      'and release only their own consumers with no unowned mounts left after final cleanup'
    );
  });
}
