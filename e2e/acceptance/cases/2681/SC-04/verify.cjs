'use strict';
// #2681 SC-04: delegated cgroup v2 limits apply to the whole execution domain
// before user code, exclude the shared tmux/Agent, and report observed facts.
const assert = require('node:assert/strict');
const { run } = require('../../../shared/control-mode-cases.cjs');
const {
  probeCapabilities, runLinuxRuntimeTest, runtimeEvidence, pending, capabilityLine,
} = require('../../../shared/sandbox-cases.cjs');

const capabilities = probeCapabilities();
const cgroup = capabilities.cgroup_v2;
if (!cgroup || !cgroup.controllers.includes('pids')) {
  pending('This runner has no delegated writable cgroup v2 controllers for an execution domain',
    [{ type: 'blocked', value: capabilityLine(capabilities) }]);
} else {
  run(({ evidence }) => {
    const output = runLinuxRuntimeTest(
      'an_execution_verifies_its_controls_and_releases_owned_resources',
    );
    const facts = runtimeEvidence(output);
    assert.ok(facts.cgroup_path, 'the execution cgroup path was reported');
    assert.equal(facts.cgroup_membership_verified, true, 'the Pane must be a member of the recorded cgroup');
    assert.equal(facts.cgroup_limits_verified, true);
    assert.equal(facts.cgroup_effective_limits['pids.max'], '64');
    assert.equal(facts.cgroup_removed, true);
    evidence.push(
      { type: 'runtime', value: 'execution ' + facts.execution_id + ' was enrolled in ' + facts.cgroup_path },
      { type: 'runtime', value: 'effective limits read back: ' + JSON.stringify(facts.cgroup_effective_limits) },
      { type: 'runtime', value: 'the shared Agent/tmux were outside the execution domain; the cgroup was removed on exit' },
    );
    return 'Delegated cgroup v2 limits were in effect for the execution domain and released with it';
  });
}
