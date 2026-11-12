'use strict';
// #2681 SC-02: a Linux on-demand execution launches an interactive Pane through
// the trusted initial command, with real filesystem and PID/IPC/User isolation.
// The measured runner must expose Bubblewrap plus those namespaces; otherwise
// the criterion stays Pending with the measured prerequisite.
const assert = require('node:assert/strict');
const { run } = require('../../../shared/control-mode-cases.cjs');
const {
  probeCapabilities, runLinuxRuntimeTest, runtimeEvidence, pending, capabilityLine,
} = require('../../../shared/sandbox-cases.cjs');

const capabilities = probeCapabilities();
if (!capabilities.backend) {
  pending('No usable Linux Sandbox backend on this runner: ' + capabilities.unavailable,
    [{ type: 'blocked', value: capabilityLine(capabilities) }]);
} else if (!(capabilities.filesystem && capabilities.namespaces.user &&
             capabilities.namespaces.pid && capabilities.namespaces.ipc)) {
  pending('The runner cannot create the requested filesystem/PID/IPC/User isolation',
    [{ type: 'blocked', value: capabilityLine(capabilities) }]);
} else {
  run(({ evidence }) => {
    const output = runLinuxRuntimeTest(
      'an_execution_verifies_its_controls_and_releases_owned_resources',
    );
    const facts = runtimeEvidence(output);
    const minimal = runtimeEvidence(
      runLinuxRuntimeTest('a_policy_without_filesystem_access_still_masks_control_paths'),
    );
    assert.equal(minimal.masked_control_paths_verified, true);
    assert.equal(facts.backend, 'linux-bwrap');
    assert.ok(facts.shell_output.includes('sandbox-alive'), 'the sandboxed shell produced output');
    assert.ok(facts.namespaces && facts.namespaces.pid, 'the PID namespace was reported');
    assert.ok(facts.namespaces.user, 'the User namespace was reported');
    assert.ok(facts.namespaces.ipc, 'the IPC namespace was reported');
    assert.ok(facts.filesystem_probes >= 2, 'visible and hidden filesystem probes were confirmed');
    evidence.push(
      { type: 'runtime', value: 'execution ' + facts.execution_id + ' on linux-bwrap ran /bin/sh inside real mount/PID/IPC/User isolation' },
      { type: 'runtime', value: 'the launch barrier verified ' + facts.filesystem_probes + ' filesystem probes before releasing the shell' },
      { type: 'runtime', value: 'sandbox namespaces: ' + JSON.stringify(facts.namespaces) },
      { type: 'runtime', value: 'the Pane ran through the trusted initial command and printed: ' + facts.shell_output },
      { type: 'runtime', value: 'a policy without a filesystem dimension still masked and verified the Agent control paths (' + minimal.filesystem_probes + ' probes)' },
    );
    return 'A Linux on-demand Pane launched through the trusted launcher with real filesystem and PID/IPC/User isolation';
  });
}
