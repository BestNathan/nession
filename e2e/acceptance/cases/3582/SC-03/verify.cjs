'use strict';
// #3582 SC-03: after a Workspace is detached and the Agent owners are reopened,
// the same Workspace identity and pinned lower reattach with the exact prior
// edits. An altered lower, missing/symlinked upper/work, a foreign owner and a
// competing physical mount all refuse without creating a fresh empty upper or
// changing the old data.
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
      'a_detached_workspace_reattaches_and_unsafe_storage_is_refused',
    );
    const facts = runtimeEvidence(output);
    for (const [key, message] of [
      ['reattach_same_upper', 'the detached Workspace reattached with its prior edits'],
      ['lower_visible_after_restart', 'the pinned Project lower was visible after restart'],
      ['changed_lower_refused', 'a changed lower was refused'],
      ['missing_upper_refused', 'a missing durable upper was refused'],
      ['symlinked_work_refused', 'a symlinked work directory was refused'],
      ['foreign_owner_refused', 'a foreign owner identity was refused'],
      ['competing_mount_refused', 'a competing physical mount was never adopted'],
      ['upper_unchanged', 'the durable bytes were unchanged by every refusal'],
      ['no_fresh_empty_upper', 'no fresh empty upper was created'],
    ]) {
      assert.equal(facts[key], true, message);
    }
    const kernel = checked('uname', ['-r'], 30000).trim();
    evidence.push({
      type: 'runtime',
      value:
        'exact SHA ' + sha + ' on Linux kernel ' + kernel + ': a managed Workspace was detached, ' +
        'the Agent owners were reopened, and the same Workspace identity plus Project lower ' +
        'reattached with its prior edit intact; a changed lower, a missing upper, a symlinked ' +
        'work directory, a foreign durable owner and a competing fuse-overlayfs mount at the ' +
        'manager-derived mountpoint each refused while the durable upper bytes stayed unchanged',
    });
    return (
      'Restart reattach preserves the exact durable edits, and every altered/missing/foreign ' +
      'state refuses without creating a fresh empty upper or touching the old data'
    );
  });
}
