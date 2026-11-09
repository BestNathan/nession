'use strict';
// #2681 SC-07: an execution's Pane survives losing its client stream; normal
// exit and failed partial startup release only owned resources; restart
// reconciliation distinguishes live from vanished Sessions and never treats a
// failed tmux query as an empty one.
const assert = require('node:assert/strict');
const { run, checked, assertRan } = require('../../../shared/control-mode-cases.cjs');
const {
  probeCapabilities, runLinuxRuntimeTest, runtimeEvidence, pending, capabilityLine,
} = require('../../../shared/sandbox-cases.cjs');

const capabilities = probeCapabilities();
if (!capabilities.backend) {
  pending('No usable Sandbox backend on this runner: ' + capabilities.unavailable,
    [{ type: 'blocked', value: capabilityLine(capabilities) }]);
} else {
  run(({ evidence }) => {
    const normal = runtimeEvidence(
      runLinuxRuntimeTest('an_execution_verifies_its_controls_and_releases_owned_resources'),
    );
    assert.equal(normal.record_removed, true);
    assert.equal(normal.execution_dir_removed, true);
    assert.equal(normal.cgroup_removed, true);

    const partial = runtimeEvidence(
      runLinuxRuntimeTest('an_aborted_launch_releases_only_its_owned_resources'),
    );
    assert.equal(partial.record_removed, true);
    assert.equal(partial.execution_dir_removed, true);

    const survival = runtimeEvidence(
      runLinuxRuntimeTest('an_execution_survives_losing_its_client_stream'),
    );
    assert.equal(survival.survived_client_loss, true);

    const reconciliation = checked(
      'cargo',
      ['test', '-p', 'nession-agent', '--lib', 'sandbox_runtime::tests', '--', '--nocapture'],
      600000,
    );
    assertRan(reconciliation, [
      'sandbox_runtime::tests::reconciliation_keeps_live_sessions_and_cleans_dead_ones',
      'sandbox_runtime::tests::a_record_outside_the_state_directory_is_not_followed',
    ]);

    evidence.push(
      { type: 'runtime', value: 'execution ' + normal.execution_id + ' released its record, directory and cgroup on normal exit' },
      { type: 'runtime', value: 'a prepared-but-aborted launch removed exactly its owned record and directory' },
      { type: 'runtime', value: 'the sandboxed Pane remained alive after its client stream disappeared' },
      { type: 'runtime', value: 'restart reconciliation kept live Sessions and removed vanished ones without following unowned paths' },
    );
    return 'Sandboxed executions survive client loss, and normal exit, partial startup and restart reconciliation release only owned resources';
  });
}
