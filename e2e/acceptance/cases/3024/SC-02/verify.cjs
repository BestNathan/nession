'use strict';
// #3024 SC-02: on a probed capable Linux host, a minimal Base Runtime EROFS
// plus a Project source EROFS and a bounded writable OverlayFS workspace launch
// an interactive shell with usable Git, expected mountinfo and no unintended
// host path exposure. An unavailable helper is Pending with the measured
// prerequisite; it is never Agent-review Pass.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run, checked } = require('../../../shared/control-mode-cases.cjs');
const {
  probeCapabilities, runLinuxRuntimeTest, runtimeEvidence, pending, capabilityLine,
} = require('../../../shared/sandbox-cases.cjs');

// The staging runner is Ubuntu 24.04; the helpers are not preinstalled. A
// failed install leaves the measured capability probe to report Pending.
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
      'an_erofs_composition_runs_a_shell_with_a_writable_overlay_workspace',
    );
    const facts = runtimeEvidence(output);
    assert.equal(facts.shell, 'ok');
    assert.equal(facts.git, 'ok');
    assert.equal(facts.erofs_mount, true);
    assert.equal(facts.overlay_mount, true);
    assert.equal(facts.host_etc_shadow_hidden, true);
    assert.ok(facts.mounts_unmounted >= 3, 'the composition mounts were unmounted');
    const kernel = checked('uname', ['-r'], 30000).trim();
    evidence.push(
      { type: 'runtime', value: 'execution ' + facts.execution_id + ' on Linux kernel ' + kernel },
      { type: 'runtime', value: 'the shell ran with Git and a writable /workspace over the Project EROFS lower' },
      { type: 'runtime', value: 'mountinfo showed fuse.erofsfuse and fuse.fuse-overlayfs; /etc/shadow from the host was absent' },
      { type: 'runtime', value: 'cleanup unmounted ' + facts.mounts_unmounted + ' owned mounts and removed the execution record' },
    );
    return (
      'A minimal Base Runtime EROFS plus a Project source EROFS launched an interactive shell ' +
      'with usable Git, a writable overlay workspace, expected mountinfo and no host /etc exposure'
    );
  });
}
