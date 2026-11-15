'use strict';
// #3582 SC-02: two simultaneously live Sandbox executions over one managed
// Workspace share the same writable /workspace and exactly one verified host
// physical fuse-overlayfs mount. Ending execution A does not revoke B, and
// releasing the last consumer unmounts without deleting the durable upper/work.
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

const imageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-overlay-3582-'));
process.env.SANDBOX_EROFS_IMAGE_ROOT = imageRoot;
const capabilities = probeCapabilities();
if (!capabilities.backend) {
  pending('No usable Linux Sandbox backend on this runner: ' + capabilities.unavailable, [
    { type: 'blocked', value: capabilityLine(capabilities) },
  ]);
} else if (!capabilities.erofs || !capabilities.erofs_overlay) {
  pending(
    'The runner cannot mount prepared EROFS images or merge a writable Overlay; the native ' +
      'logical-Overlay proof is blocked by the measured capability, not passed by a mock',
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
    assert.equal(facts.same_mountpoint, true, 'both executions bind the same mountpoint');
    assert.equal(facts.same_generation, true, 'both executions share one mount generation');
    assert.equal(facts.consumers, 2, 'both live executions hold identified consumer leases');
    assert.equal(facts.first_release_kept_mount, true, 'ending A does not revoke B');
    assert.equal(facts.second_live_after_first_release, true, 'B stays live after A is released');
    assert.equal(facts.shared_write_visible, true, 'the two consumers see one writable view');
    assert.equal(facts.durable_upper_preserved, true, 'the persistent upper/work survive');
    assert.equal(facts.unmounted_after_last_release, true, 'the last release unmounts');
    const kernel = checked('uname', ['-r'], 30000).trim();
    evidence.push({
      type: 'runtime',
      value:
        'exact SHA ' + sha + ' on Linux kernel ' + kernel + ': two concurrently verified Sandbox ' +
        'executions over managed Workspace ' + facts.workspace + ' shared one physical ' +
        'fuse-overlayfs mount (consumers=2, same mountpoint/generation); execution A read B\'s ' +
        'write, A was released while B stayed live and read/wrote the same durable view; the last ' +
        'release unmounted the physical Overlay (mountinfo count 0) and retained upper/work',
    });
    return (
      'Two concurrently live executions share one writable Workspace Merged View; ending one does ' +
      'not revoke the other, and the last release unmounts without deleting the durable upper'
    );
  });
}
