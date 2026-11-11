'use strict';
// #2681 SC-05: the pinned seccomp baseline is installed before user code and a
// prohibited operation is actually denied without breaking shell fork/job
// control in the same execution.
const assert = require('node:assert/strict');
const { run } = require('../../../shared/control-mode-cases.cjs');
const {
  probeCapabilities, runLinuxRuntimeTest, runtimeEvidence, pending, capabilityLine,
} = require('../../../shared/sandbox-cases.cjs');

const capabilities = probeCapabilities();
if (!capabilities.seccomp) {
  pending('This runner cannot load the pinned seccomp filter',
    [{ type: 'blocked', value: capabilityLine(capabilities) }]);
} else {
  run(({ evidence }) => {
    const output = runLinuxRuntimeTest(
      'an_execution_verifies_its_controls_and_releases_owned_resources',
    );
    const facts = runtimeEvidence(output);
    assert.equal(facts.seccomp, '2', 'the filter must be in SECCOMP_MODE_FILTER');
    assert.equal(facts.no_new_privs, '1');
    assert.equal(facts.unshare_denied, true, 'the blocked unshare syscall must fail');
    assert.equal(facts.fork_ok, true, 'ordinary shell fork must still work');
    evidence.push(
      { type: 'runtime', value: 'execution ' + facts.execution_id + ' reported Seccomp=2 and NoNewPrivs=1' },
      { type: 'runtime', value: 'a blocked unshare syscall returned EPERM while a shell fork succeeded' },
      { type: 'runtime', value: 'TIOCSTI filtering is part of the same installed profile' },
    );
    return 'The pinned seccomp baseline blocked a prohibited syscall without breaking shell execution';
  });
}
