'use strict';
// #2681 SC-06: the macOS backend reports what it actually verified and rejects
// Linux-native guarantees. Actual Seatbelt support cannot be observed from a
// Linux runner, so that half stays Pending there instead of being inferred.
const { run, checked, assertRan } = require('../../../shared/control-mode-cases.cjs');
const { pending } = require('../../../shared/sandbox-cases.cjs');

if (process.platform !== 'darwin') {
  pending('No approved macOS runner is available to observe actual Seatbelt support',
    [{ type: 'blocked', value: 'platform=' + process.platform + '; macOS Seatbelt enforcement cannot be inferred from another OS' }]);
} else {
  run(({ evidence }) => {
    const macos = checked(
      'cargo',
      ['test', '-p', 'nession-sandbox', '--lib', 'macos::', '--', '--nocapture'],
      600000,
    );
    assertRan(macos, [
      'macos::tests::the_seatbelt_probe_observes_real_allow_and_deny',
    ]);
    const validation = checked(
      'cargo',
      ['test', '-p', 'nession-sandbox', '--lib', 'capabilities::tests::linux_native_keys_are_refused_on_macos', '--', '--nocapture'],
      600000,
    );
    assertRan(validation, [
      'capabilities::tests::linux_native_keys_are_refused_on_macos',
    ]);
    evidence.push(
      { type: 'runtime', value: 'the macOS probe observed a real Seatbelt network deny against a control connection' },
      { type: 'runtime', value: 'filesystem.access was rejected because the path allow-list was not verified' },
      { type: 'runtime', value: 'process.linux_namespaces, resource.cgroup_v2 and syscall.seccomp were rejected as Linux-native' },
    );
    return 'macOS reports only its verified Seatbelt capability and rejects every Linux-native guarantee without claiming equivalence';
  });
}
