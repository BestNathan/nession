'use strict';
// #3449 SC-03: helper timeout, stderr stall, digest mismatch, concurrent
// acquire/release and a busy/failed unmount never return a false lease,
// invalidate a live consumer or forget a still-mounted resource. Cleanup is
// bounded, observable and retryable.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run, checked, assertRan } = require('../../../shared/control-mode-cases.cjs');
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
    const bounded = checked(
      'cargo',
      ['test', '-p', 'nession-erofs', '--features', 'mount', '--lib', 'mount_manager', '--', '--nocapture'],
      600000,
    );
    assertRan(bounded, [
      'mount_manager::tests::a_hanging_mount_helper_is_bounded_and_leaves_a_retryable_failure',
      'mount_manager::tests::a_digest_mismatch_fails_closed_without_spawning_the_helper',
    ]);

    const failed = runtimeEvidence(
      runLinuxRuntimeTest('a_failed_shared_unmount_is_durable_bounded_and_retryable'),
    );
    assert.equal(failed.failed_unmount_retained, true);
    assert.equal(failed.retry_succeeded, true);
    assert.equal(failed.bounded, true);

    const concurrent = runtimeEvidence(
      runLinuxRuntimeTest('concurrent_shared_acquisitions_keep_one_physical_mount'),
    );
    assert.equal(concurrent.consumers, 4);
    assert.equal(concurrent.physical_mounts, 1);

    evidence.push(
      { type: 'runtime', value: 'a hanging erofsfuse helper was killed at the bounded deadline and left a retryable Failed state' },
      { type: 'runtime', value: 'a digest mismatch failed without spawning the helper or granting a lease' },
      { type: 'runtime', value: 'four concurrent consumers observed one physical mount and one generation; the last release unmounted it' },
      { type: 'runtime', value: 'a fail-once fusermount retained the live mount as Failed evidence and a bounded retry removed it' },
    );
    return (
      'Mount/helper failures, concurrent acquire/release and failed unmounts stay bounded, ' +
      'observable and retryable without a false lease or forgotten live mount'
    );
  });
}
