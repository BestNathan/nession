'use strict';
// #3698 SC-03: a managed persistent Workspace reuses one ordered lower set and
// one durable upper across an Agent-owner restart. Reordered or missing lowers
// are refused without losing the durable bytes. Project Location Bind
// ownership is unchanged because it never receives an Overlay upper.
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

const imageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-multilower-3698-'));
process.env.SANDBOX_EROFS_IMAGE_ROOT = imageRoot;
const capabilities = probeCapabilities();
if (!capabilities.backend) {
  pending('No usable Linux Sandbox backend on this runner: ' + capabilities.unavailable, [
    { type: 'blocked', value: capabilityLine(capabilities) },
  ]);
} else if (!capabilities.erofs || !capabilities.erofs_overlay) {
  pending(
    'The runner cannot mount ordered EROFS lowers through a shared writable Overlay; the native ' +
      'Workspace-restart proof is blocked by the measured capability',
    [{ type: 'blocked', value: capabilityLine(capabilities) }],
  );
} else {
  run(({ evidence }) => {
    const sha = targetSha();
    const output = runLinuxRuntimeTest(
      'a_managed_workspace_keeps_ordered_lowers_across_restart_and_refuses_reordering',
    );
    const facts = runtimeEvidence(output);
    assert.equal(facts.two_consumers_shared, true, 'two consumers share one ordered view');
    assert.equal(facts.ordered_reattach, true, 'the same ordered lower set reattaches');
    assert.equal(facts.ordered_lowers, 2, 'both ordered lowers are part of the compatibility key');
    assert.equal(facts.reordered_refused, true, 'a reordered lower set is refused');
    assert.equal(facts.missing_lower_refused, true, 'a missing lower is refused');
    assert.equal(facts.durable_upper_preserved, true, 'the durable upper is preserved');
    const projectLocation = checked(
      'cargo',
      [
        'test', '-q', '-p', 'nession-agent',
        'a_project_location_is_external_and_refuses_a_lower', '--', '--nocapture',
      ],
      900000,
    );
    assert.match(
      projectLocation,
      /a_project_location_is_external_and_refuses_a_lower \.\.\. ok/,
      'a Project Location remains an external Bind and refuses an Overlay lower',
    );
    const kernel = checked('uname', ['-r'], 30000).trim();
    evidence.push({
      type: 'runtime',
      value:
        'exact SHA ' + sha + ' on Linux kernel ' + kernel + ': a managed Workspace reused its ' +
        'exact ordered two-lower identity across an Agent-owner restart with the durable edit ' +
        'intact; a reordered and a missing lower were both refused without data loss. A Project ' +
        'Location remains a direct user-owned Bind and never receives an Overlay upper',
    });
    return (
      'A managed persistent Workspace keeps one ordered lower key and durable upper across ' +
      'restart, refuses reordered/missing lowers, and leaves Project Location Bind ownership ' +
      'unchanged'
    );
  });
}
