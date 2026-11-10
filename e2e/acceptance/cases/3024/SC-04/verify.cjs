'use strict';
// #3024 SC-04: the nested mount/overlay lifecycle survives client detach, and
// cleanup releases only the execution's own mounts. Two executions share the
// same immutable EROFS images; cleaning one leaves the other's mounts live.
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
    assert.equal(facts.detached_pane_survived, true);
    assert.equal(facts.shared_images_remained_mounted, true);
    assert.ok(facts.first_mounts_released >= 3);
    assert.ok(facts.second_mounts_released >= 3);
    evidence.push(
      { type: 'runtime', value: 'executions ' + facts.first_execution + ' and ' + facts.second_execution + ' shared the same Base/Project/toolchain images' },
      { type: 'runtime', value: 'client detach left the first Pane and all of its mounts alive' },
      { type: 'runtime', value: 'cleaning the first execution unmounted only its ' + facts.first_mounts_released + ' mounts; the second stayed mounted' },
      { type: 'runtime', value: 'the second execution released its ' + facts.second_mounts_released + ' mounts and record on exit' },
    );
    return (
      'Nested mount/Overlay lifecycle survives client detach and cleanup reaps only owned ' +
      'resources, while read-only image refs remain available to the other Session'
    );
  });
}
