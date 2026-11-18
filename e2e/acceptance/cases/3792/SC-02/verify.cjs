'use strict';
// #3792 SC-02: a Linux Agent executes a Host-root Pane with one verified EROFS
// toolchain at its authorized /opt target and an Agent-managed writable
// Workspace that retains writes across a second Pane. An unauthorized image
// source is refused before any mount, and the persistent Workspace survives.
const assert = require('node:assert/strict');
const fs = require('node:fs');
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

const capabilities = probeCapabilities();
if (!capabilities.backend) {
  pending('No usable Linux Sandbox backend on this runner: ' + capabilities.unavailable,
    [{ type: 'blocked', value: capabilityLine(capabilities) }]);
} else if (!fs.existsSync('/workspace')) {
  // A read-only Host root cannot grow a top-level mountpoint. The approved
  // runner provisions `/workspace`; without it the Case stays Pending rather
  // than claiming the Workspace behavior was proven.
  pending('This runner has no /workspace mountpoint for a Host-root Workspace',
    [{ type: 'blocked', value: 'missing host mountpoint /workspace' }]);
} else if (!(capabilities.filesystem && capabilities.erofs)) {
  pending('The runner cannot bind the Workspace or mount a verified EROFS toolchain',
    [{ type: 'blocked', value: capabilityLine(capabilities) }]);
} else {
  run(({ evidence }) => {
    const output = runLinuxRuntimeTest(
      'a_host_root_composition_mounts_a_verified_toolchain_and_keeps_workspace_writes',
    );
    const facts = runtimeEvidence(output);
    assert.equal(facts.backend, 'linux-bwrap');
    assert.equal(facts.tool_visible_at, '/opt/go');
    assert.equal(facts.workspace_persisted, true);
    assert.equal(facts.second_pane_read_back, true);
    assert.equal(facts.unauthorized_source_refused_before_mount, true);
    assert.match(String(facts.first_execution), /^sandbox-/);
    evidence.push(
      { type: 'runtime', value: 'Host-root Pane ' + facts.first_execution + ' on linux-bwrap mounted the verified EROFS toolchain at ' + facts.tool_visible_at },
      { type: 'runtime', value: 'the Agent-managed Workspace retained a write that a second Pane read back' },
      { type: 'runtime', value: 'a toolchain source outside the Agent-authorized image root was refused before any mount and the Workspace bytes survived' },
      { type: 'runtime', value: 'capabilities: ' + capabilityLine(capabilities) },
    );
    return 'A Linux Host-root Pane mounted a verified toolchain under /opt and a persistent Workspace that kept writes across Panes';
  });
}
