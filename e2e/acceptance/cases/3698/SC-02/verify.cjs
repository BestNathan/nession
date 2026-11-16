'use strict';
// #3698 SC-02: an explicitly selected writable RootFS merges the immutable
// Base image with an execution-owned transient upper/work. A write is visible
// only inside that execution, the image bytes never change, and cleanup
// removes the transient directories after a verified unmount.
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

const imageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-rootfs-3698-'));
process.env.SANDBOX_EROFS_IMAGE_ROOT = imageRoot;
const capabilities = probeCapabilities();
if (!capabilities.backend) {
  pending('No usable Linux Sandbox backend on this runner: ' + capabilities.unavailable, [
    { type: 'blocked', value: capabilityLine(capabilities) },
  ]);
} else if (!capabilities.erofs || !capabilities.erofs_overlay) {
  pending(
    'The runner cannot mount a writable RootFS over an immutable EROFS Base; the native ' +
      'transient-overlay proof is blocked by the measured capability',
    [{ type: 'blocked', value: capabilityLine(capabilities) }],
  );
} else {
  run(({ evidence }) => {
    const sha = targetSha();
    const output = runLinuxRuntimeTest(
      'a_writable_rootfs_is_transient_and_never_mutates_the_image',
    );
    const facts = runtimeEvidence(output);
    assert.equal(facts.transient_write_visible, true, 'the write is visible inside the execution');
    assert.equal(facts.whiteout_isolated, true, 'a deleted lower file reappears in a later execution');
    assert.equal(facts.transient_recorded, true, 'the execution records its transient RootFS');
    assert.equal(facts.transient_upper_removed, true, 'cleanup removes the transient upper/work');
    assert.equal(facts.base_image_unchanged, true, 'the immutable Base image bytes are unchanged');
    assert.equal(facts.later_execution_isolated, true, 'a later execution cannot see the write');
    const kernel = checked('uname', ['-r'], 30000).trim();
    evidence.push({
      type: 'runtime',
      value:
        'exact SHA ' + sha + ' on Linux kernel ' + kernel + ': a writable RootFS wrote through an ' +
        'execution-owned transient upper, the write was recorded and visible only in that ' +
        'execution; cleanup strictly unmounted and removed the transient upper/work, the Base ' +
        'image bytes stayed identical, and a later execution was isolated',
    });
    return (
      'Writable RootFS writes stay in a disposable execution-owned upper, never mutate the ' +
      'immutable image, and disappear after verified cleanup'
    );
  });
}
