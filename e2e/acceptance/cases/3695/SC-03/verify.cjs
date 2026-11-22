'use strict';
// #3695 SC-03: the Sandbox-owned Overlay manager keeps the #3582 recovery
// contract after the ownership migration. Reattach preserves durable bytes;
// changed ordered-lower identity, stale/foreign mounts, a failed unmount and
// missing upper/work all fail closed with no data loss; prior persisted
// records and legacy Workspace paths stay readable.
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
      'Sandbox-owned manager; the native recovery proof is blocked by the measured capability',
    [{ type: 'blocked', value: capabilityLine(capabilities) }],
  );
} else {
  run(({ evidence }) => {
    const sha = targetSha();
    const detachOutput = runLinuxRuntimeTest(
      'a_detached_workspace_reattaches_and_unsafe_storage_is_refused',
    );
    const detach = runtimeEvidence(detachOutput);
    for (const [key, message] of [
      ['reattach_same_upper', 'the detached Workspace reattached with its prior edits'],
      ['lower_visible_after_restart', 'the pinned Project lower was visible after restart'],
      ['changed_lower_refused', 'a changed ordered lower identity was refused'],
      ['missing_upper_refused', 'a missing durable upper was refused'],
      ['symlinked_work_refused', 'a symlinked work directory was refused'],
      ['foreign_owner_refused', 'a foreign owner identity was refused'],
      ['competing_mount_refused', 'a stale/foreign physical mount was never adopted'],
      ['upper_unchanged', 'the durable bytes were unchanged by every refusal'],
      ['no_fresh_empty_upper', 'no fresh empty upper was created'],
    ]) {
      assert.equal(detach[key], true, message);
    }

    const crashOutput = runLinuxRuntimeTest(
      'a_crashed_overlay_owner_is_recovered_only_from_verified_identity',
    );
    const crash = runtimeEvidence(crashOutput);
    for (const [key, message] of [
      ['restart_adopted', 'a verified crashed-owner mount was re-adopted'],
      ['verified_after_restart', 'the adopted view was verified'],
      ['missing_mount_unavailable', 'a disappeared mount was unavailable, never served'],
      ['durable_upper_preserved', 'the crashed execution durable bytes survived'],
      ['lower_released_after_verified_unmount', 'the lower pin was released only after unmount'],
    ]) {
      assert.equal(crash[key], true, message);
    }

    const failureOutput = runLinuxRuntimeTest(
      'an_injected_overlay_failure_leaves_recoverable_state_without_data_loss',
    );
    const failure = runtimeEvidence(failureOutput);
    for (const [key, message] of [
      ['mount_failure_failed_state', 'a mount failure retained recoverable state'],
      ['mount_failure_not_ready', 'a failed mount was never reported ready'],
      ['unverified_mount_not_ready', 'an unverified mount was never reported ready'],
      ['failed_unmount_retained_mount', 'a failed unmount retained the live mount'],
      ['lower_pin_retained', 'a failed unmount retained the lower pin'],
      ['retry_succeeded', 'a later retry reclaimed the mount'],
      ['durable_upper_preserved', 'the durable upper survived failure and retry'],
      ['durable_identity_cleared_after_retry', 'the stale identity was cleared after retry'],
      ['no_native_fallback', 'a missing Overlay manager never fell back to Native'],
    ]) {
      assert.equal(failure[key], true, message);
    }

    const legacyOutput = runLinuxRuntimeTest(
      'a_legacy_record_with_a_failed_unmount_is_retained_for_retry',
    );
    const legacy = runtimeEvidence(legacyOutput);
    assert.equal(
      legacy.legacy_unmount_failure_retained,
      true,
      'a failed legacy unmount retained the durable record and occupied directory',
    );
    assert.equal(
      legacy.legacy_unmount_retry_succeeded,
      true,
      'a later retry completed the legacy cleanup',
    );

    const kernel = checked('uname', ['-r'], 30000).trim();
    evidence.push({
      type: 'runtime',
      value:
        'exact SHA ' + sha + ' on Linux kernel ' + kernel + ': after moving physical ownership ' +
        'into nession-sandbox::mount::overlay, restart reattach preserved the durable upper; a ' +
        'changed lower, missing upper, symlinked work, foreign owner, competing mount, crashed ' +
        'owner and injected mount/unmount failure each failed closed without data loss; the ' +
        'last verified unmount released the lower and legacy durable paths stayed readable; a ' +
        'legacy record whose strict unmount failed kept its durable record and occupied ' +
        'directory, and a later retry completed the cleanup',
    });
    return (
      'The Sandbox-owned Overlay manager preserves verified restart recovery, retains a ' +
      'failed legacy cleanup for retry, and fails closed for changed/foreign/missing/failed ' +
      'state without touching durable Workspace bytes'
    );
  });
}
