'use strict';
// #3582 SC-04: injected mount/unmount failures and a process crash during
// prepare are recovered from the durable mount identity/generation, the owner
// lock and actual mountinfo. Recovery never reports an unverified mount ready,
// releases the lower prematurely, deletes a live/uncertain upper, adopts a
// foreign mount or silently falls back to Native.
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
    const failure = runtimeEvidence(
      runLinuxRuntimeTest(
        'an_injected_overlay_failure_leaves_recoverable_state_without_data_loss',
      ),
    );
    const restart = runtimeEvidence(
      runLinuxRuntimeTest('a_crashed_overlay_owner_is_recovered_only_from_verified_identity'),
    );
    for (const [key, message] of [
      ['mount_failure_failed_state', 'a failed mount leaves an inspectable Failed state'],
      ['mount_failure_not_ready', 'a failed mount is never Ready'],
      ['unverified_mount_not_ready', 'a helper that mounted nothing is never Ready'],
      ['failed_unmount_retained_mount', 'a failed unmount retains the live mount'],
      ['lower_pin_retained', 'a failed Overlay unmount retains the lower pin'],
      ['retry_succeeded', 'the bounded retry releases the physical Overlay'],
      ['durable_upper_preserved', 'durable bytes survive failure and retry'],
      ['durable_identity_cleared_after_retry', 'the durable identity is cleared only after the retry'],
      ['no_native_fallback', 'a missing Overlay manager refuses the composition'],
    ]) {
      assert.equal(failure[key], true, message);
    }
    for (const [key, message] of [
      ['restart_adopted', 'a new manager adopted the crashed durable consumer'],
      ['verified_after_restart', 'the adopted mount was verified against identity and mountinfo'],
      ['missing_mount_unavailable', 'a disappeared mount was reported unavailable, never served'],
      ['durable_upper_preserved', 'the crash edit survived in the durable upper'],
      ['lower_released_after_verified_unmount', 'the lower was released only after the verified unmount'],
    ]) {
      assert.equal(restart[key], true, message);
    }
    const kernel = checked('uname', ['-r'], 30000).trim();
    evidence.push({
      type: 'runtime',
      value:
        'exact SHA ' + sha + ' on Linux kernel ' + kernel + ': an injected fuse-overlayfs mount ' +
        'failure left a Failed state with the lower released and no mount; a helper that mounted ' +
        'nothing was never Ready; an injected unmount failure retained the live mount, the lower ' +
        'pin and the durable upper and a bounded retry released them; a crashed owner process ' +
        'leaving a live mount was re-adopted only from the verified durable identity and a mount ' +
        'that disappeared was reported unavailable rather than served',
    });
    return (
      'Injected mount/unmount failures and a crash during prepare recover only from verified ' +
      'durable identity and mountinfo, never delete live or uncertain bytes, and never fall back'
    );
  });
}
