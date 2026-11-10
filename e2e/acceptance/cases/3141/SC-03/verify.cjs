'use strict';
// #3141 SC-03: on the approved Linux runner, a beyond-V1 native key
// (`cpu.weight`) is written before launch, read back from the owned execution
// cgroup, and becomes the recorded effective value. An invalid kernel-native
// value fails with the exact OS error, removes the partial child, and never
// falls back to Native.
const assert = require('node:assert/strict');
const {
  run,
  crateTests,
  assertRan,
} = require('../../../shared/control-mode-cases.cjs');
const {
  probeCapabilities,
  runLinuxRuntimeTest,
  runtimeEvidence,
  pending,
  capabilityLine,
} = require('../../../shared/sandbox-cases.cjs');

const capabilities = probeCapabilities();
const cgroup = capabilities.cgroup_v2;
if (!cgroup || !['cpu', 'memory'].every((name) => cgroup.controllers.includes(name))) {
  pending('This runner has no delegated writable cpu/memory cgroup v2 child', [
    { type: 'blocked', value: capabilityLine(capabilities) },
  ]);
} else {
  run(({ evidence }) => {
    const output = runLinuxRuntimeTest(
      'native_beyond_v1_controls_apply_readback_and_fail_closed',
    );
    const facts = runtimeEvidence(output);
    assert.equal(facts.cpu_weight_readback, '100');
    assert.equal(facts.memory_high_readback, 'max');
    assert.equal(
      facts.effective_policy_matches_readback,
      true,
      'inside must report the kernel readback, not the draft',
    );
    assert.match(
      String(facts.invalid_value_error),
      /os error 22|Invalid argument/,
      'the exact kernel error must be reported',
    );
    assert.deepEqual(
      facts.failed_child_removed,
      [],
      'a failed prepare must remove its owned child cgroup',
    );
    assert.equal(facts.cgroup_removed, true);
    assert.equal(facts.absent_key_refused, true);

    const compile = crateTests(
      'nession-sandbox',
      ['--lib', 'policy::tests::native_cgroup_values_pass_through_without_application_parsers'],
      600_000,
    );
    assertRan(compile, ['native_cgroup_values_pass_through_without_application_parsers']);
    evidence.push(
      {
        type: 'runtime',
        value:
          'the execution cgroup read back cpu.weight=' +
          facts.cpu_weight_readback +
          ' and memory.high=' +
          facts.memory_high_readback +
          ' after prelaunch writes',
      },
      {
        type: 'runtime',
        value:
          'the recorded effective policy used those kernel readbacks instead of the requested draft',
      },
      {
        type: 'runtime',
        value:
          'an invalid cpu.max was refused by the kernel with its OS error; the partial child cgroup was removed and no execution was claimed',
      },
      {
        type: 'runtime',
        value:
          'an undiscovered controller file was refused before any write, without a Native fallback',
      },
    );
    return 'A real delegated execution installed a beyond-V1 native control, observed the kernel readback, and failed closed with exact OS errors and cleanup';
  });
}
