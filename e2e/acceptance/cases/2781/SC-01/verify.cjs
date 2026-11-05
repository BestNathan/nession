'use strict';
// #2781 SC-01: a failed restore-to-base is reported as an error and the
// per-Session durable binding keeps the exact original base value — including
// the `None` marker for a key that was originally absent — so restoration stays
// pending. A successful restoration releases the baseline entry.
const {
  run,
  targetSha,
  cargoTests,
  assertRan,
} = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const output = cargoTests(
    ['--lib', 'tmux::env::tests::a_failed_'],
    100000,
  );
  assertRan(output, [
    'a_failed_restore_keeps_the_base_value_and_a_later_apply_retries_it',
    'a_failed_unset_keeps_the_absent_baseline_and_a_later_apply_unsets_it',
  ]);
  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': failed set-environment restore kept baseline ' +
      'MODE=Some(default) with status error; failed unset kept ABSENT=None; ' +
      'both errors surfaced from apply_binding; a confirmed restore released ' +
      'its baseline entry',
  });
  return 'A failed restore-to-base is an explicit error and keeps the exact durable base value and pending intent';
});
