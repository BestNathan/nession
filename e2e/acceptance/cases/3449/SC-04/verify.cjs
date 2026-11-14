'use strict';
// #3449 SC-04: after an Agent restart, durable consumers are reconstructed
// from execution records and adopted only when the sidecar identity and
// mountinfo both verify. A missing/stale/unknown mount is reported and never
// silently served or adopted by digest guess.
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
if (!capabilities.backend || !capabilities.erofs) {
  pending('The runner cannot mount prepared EROFS images', [
    { type: 'blocked', value: capabilityLine(capabilities) },
  ]);
} else {
  run(({ evidence }) => {
    const facts = runtimeEvidence(
      runLinuxRuntimeTest(
        'a_restarted_manager_adopts_a_verified_mount_and_never_serves_a_disappeared_one',
      ),
    );
    assert.equal(facts.adopted_after_restart, true);
    assert.equal(facts.missing_mount_reported, true);
    assert.equal(facts.stale_identity_reclaimed, true);
    const kernel = checked('uname', ['-r'], 30000).trim();
    evidence.push(
      { type: 'runtime', value: 'Linux kernel ' + kernel },
      { type: 'runtime', value: 'a new manager instance adopted a surviving verified mount and its durable consumer' },
      { type: 'runtime', value: 'a consumer whose physical mount disappeared was reported unavailable and never served' },
      { type: 'runtime', value: 'an unprotected stale identity was reclaimed only after mountinfo proved the mount gone' },
    );
    return (
      'Restart recovery adopts surviving verified mounts, preserves their consumers, and ' +
      'never serves or adopts a missing, stale or unknown physical mount'
    );
  });
}
