'use strict';
// #3449 SC-02: on a real supported Linux FUSE runner, two distinct active
// executions acquiring the same verified SHA observe one physical erofsfuse
// mount with two distinct leases; releasing one keeps the other readable, and
// only the last confirmed consumer reclaims the mount.
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
    const output = runLinuxRuntimeTest(
      'two_compositions_share_images_and_release_only_their_own_mounts',
    );
    const facts = runtimeEvidence(output);
    assert.equal(facts.one_physical_mount_per_digest, true);
    assert.ok(facts.shared_mounts >= 3, 'Base, Project and toolchain are shared');
    assert.equal(facts.detached_pane_survived, true);
    assert.equal(facts.shared_images_remained_mounted, true);
    assert.ok(facts.first_mounts_released >= 3);
    assert.ok(facts.second_mounts_released >= 3);
    evidence.push(
      {
        type: 'runtime',
        value:
          'executions ' + facts.first_execution + ' and ' + facts.second_execution +
          ' acquired the same ' + facts.shared_mounts + ' verified digests through distinct leases',
      },
      {
        type: 'runtime',
        value:
          'one physical mount per digest was observed; releasing the first execution left all ' +
          'shared mounts readable for the second',
      },
      {
        type: 'runtime',
        value:
          'only the last confirmed consumer reclaimed the physical mounts; both records were removed',
      },
    );
    return (
      'Two active executions share one physical EROFS mount per verified SHA, release ' +
      'independently, and reclaim only after the last consumer is gone'
    );
  });
}
