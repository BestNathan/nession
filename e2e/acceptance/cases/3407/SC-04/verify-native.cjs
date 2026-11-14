'use strict';
// #3407 SC-04 (native half): in a supported Linux EROFS Sandbox, the selected
// managed Workspace is the durable writable storage under a pinned Project
// lower; a second Enter observes the same durable upper after cleanup. The
// unit half runs in verify-units.cjs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run, targetSha, checked } = require('../../../shared/control-mode-cases.cjs');
const {
  probeCapabilities, runLinuxRuntimeTest, runtimeEvidence, pending, capabilityLine,
} = require('../../../shared/sandbox-cases.cjs');

try {
  checked('sudo', ['apt-get', 'update', '-qq'], 60000);
  checked(
    'sudo',
    ['apt-get', 'install', '-y', '-qq', 'erofs-utils', 'erofsfuse', 'fuse3', 'fuse-overlayfs'],
    60000,
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
    const sha = targetSha();
    const output = runLinuxRuntimeTest(
      'a_managed_workspace_keeps_its_durable_upper_across_overlay_reentry',
    );
    const facts = runtimeEvidence(output);
    assert.equal(facts.first_overlay, true, 'the first Enter must install the Overlay');
    assert.equal(facts.durable_upper_preserved, true, 'the sandbox write must land in the durable upper');
    assert.equal(facts.reentry_same_bytes, true, 're-entry must observe the same durable upper');
    assert.equal(facts.workspace_survived_cleanup, true, 'cleanup must release the lease, not bytes');
    assert.match(facts.project_lower_digest, /^sha256:[0-9a-f]{64}$/);

    evidence.push({
      type: 'runtime',
      value:
        'exact SHA ' + sha + ': a managed Workspace directory was authorized outside the execution ' +
        'state directory and merged with project lower ' + facts.project_lower_digest + ' through ' +
        'fuse-overlayfs; a sandbox write landed in the durable upper; after cleanup and a second ' +
        'Enter the same bytes and the same Project lower were visible, and the managed directory ' +
        'survived cleanup',
    });
    return 'A managed durable upper over a pinned Project EROFS lower survives re-entry without losing bytes';
  });
}
