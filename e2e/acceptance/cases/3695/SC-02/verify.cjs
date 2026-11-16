'use strict';
// #3695 SC-02: two Sandbox executions over one managed Workspace pass through
// the typed MountPlan/OverlayBackend and share exactly one verified physical
// writable fuse-overlayfs view. Ending one does not unmount the other; the last
// release preserves the durable upper/work bytes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run, targetSha, checked } = require('../../../shared/control-mode-cases.cjs');
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
  console.error('could not install the EROFS/FUSE helpers: ' + error.message);
}

const imageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-overlay-3695-'));
process.env.SANDBOX_EROFS_IMAGE_ROOT = imageRoot;
const capabilities = probeCapabilities();
if (!capabilities.backend) {
  pending('No usable Linux Sandbox backend on this runner: ' + capabilities.unavailable, [
    { type: 'blocked', value: capabilityLine(capabilities) },
  ]);
} else if (!capabilities.erofs || !capabilities.erofs_overlay) {
  pending(
    'The runner cannot mount prepared EROFS images or merge a writable Overlay through the ' +
      'Sandbox MountPlan; the native shared-view proof is blocked by the measured capability',
    [{ type: 'blocked', value: capabilityLine(capabilities) }],
  );
} else {
  run(({ evidence }) => {
    const sha = targetSha();
    const output = runLinuxRuntimeTest(
      'two_executions_share_one_physical_workspace_overlay_and_release_safely',
    );
    const facts = runtimeEvidence(output);
    assert.equal(facts.physical_overlays, 1, 'exactly one physical Overlay mount');
    assert.equal(facts.same_mountpoint, true, 'both executions bind the same manager view');
    assert.equal(facts.same_generation, true, 'both executions share one mount generation');
    assert.equal(facts.consumers, 2, 'both live executions hold identified consumer leases');
    assert.equal(facts.first_release_kept_mount, true, 'ending A does not revoke B');
    assert.equal(facts.second_live_after_first_release, true, 'B stays live after A is released');
    assert.equal(facts.shared_write_visible, true, 'the consumers see one writable view');
    assert.equal(facts.durable_upper_preserved, true, 'the durable upper/work survive');
    assert.equal(facts.unmounted_after_last_release, true, 'the last release unmounts');
    const kernel = checked('uname', ['-r'], 30000).trim();
    evidence.push({
      type: 'runtime',
      value:
        'exact SHA ' + sha + ' on Linux kernel ' + kernel + ': two verified Sandbox executions ' +
        'over managed Workspace ' + facts.workspace + ' passed through the typed MountPlan and ' +
        'shared one physical fuse-overlayfs view (consumers=2, same mountpoint/generation); ' +
        'release A kept B live; the last release unmounted and retained upper/work',
    });
    return (
      'Two Sandbox executions share exactly one typed-Overlay physical view, release ' +
      'independently, and the last release preserves durable Workspace bytes'
    );
  });
}
