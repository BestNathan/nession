'use strict';
// #3698 SC-01: an ordered set of two verified read-only EROFS lowers produces
// one deterministic merged view. The first lower shadows later ones, both
// remain visible where they do not conflict, and a write lands in the durable
// upper. Invalid ordering is covered by the same suite's negative tests.
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
    'The runner cannot mount ordered EROFS lowers through a writable Overlay; the native ' +
      'multi-lower proof is blocked by the measured capability',
    [{ type: 'blocked', value: capabilityLine(capabilities) }],
  );
} else {
  run(({ evidence }) => {
    const sha = targetSha();
    const output = runLinuxRuntimeTest(
      'ordered_multi_lower_workspace_merges_by_declared_priority',
    );
    const facts = runtimeEvidence(output);
    assert.equal(facts.shadow_top, true, 'the first lower shadows later lowers');
    assert.equal(facts.both_lowers_visible, true, 'non-conflicting files from both lowers are visible');
    assert.equal(facts.durable_upper_write, true, 'a write lands in the durable upper');
    assert.equal(facts.ordered_lowers, 2, 'both ordered lowers are bound');
    assert.equal(facts.physical_overlays, 1, 'exactly one physical Multi-Lower Overlay');
    assert.equal(facts.lowers_released, true, 'every lower lease is released after the last consumer');
    const kernel = checked('uname', ['-r'], 30000).trim();
    evidence.push({
      type: 'runtime',
      value:
        'exact SHA ' + sha + ' on Linux kernel ' + kernel + ': two verified EROFS lowers were ' +
        'merged in declared order (top shadows bottom; both non-conflicting files visible); the ' +
        'write reached the durable upper, exactly one physical fuse-overlayfs view existed, and ' +
        'both lower leases were released after cleanup',
    });
    return (
      'Ordered EROFS lowers produce one deterministic merged Workspace view with declared ' +
      'priority, durable writes and correct lease release'
    );
  });
}
