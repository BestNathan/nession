'use strict';
// #2781 SC-02: after the failed restore, tmux recovery plus a reapply of the
// current desired binding restores the original value (or unsets an originally
// absent key), including from a reconstructed EnvManager with only the durable
// state directory. A repeated failure stays an explicit error instead of a
// falsely converged revision.
const {
  run,
  targetSha,
  cargoTests,
  assertRan,
} = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const restored = cargoTests(
    ['--lib', 'tmux::env::tests::a_failed_restore_keeps_the_base_value'],
    100000,
  );
  assertRan(restored, [
    'a_failed_restore_keeps_the_base_value_and_a_later_apply_retries_it',
  ]);

  const unset = cargoTests(
    ['--lib', 'tmux::env::tests::a_failed_unset_keeps_the_absent_baseline'],
    100000,
  );
  assertRan(unset, [
    'a_failed_unset_keeps_the_absent_baseline_and_a_later_apply_unsets_it',
  ]);

  const restart = cargoTests(
    ['--lib', 'tmux::env::tests::a_recorded_binding_survives_an_agent_restart'],
    100000,
  );
  assertRan(restart, ['a_recorded_binding_survives_an_agent_restart']);

  const pending = cargoTests(
    ['--lib', 'tmux::env::tests::a_repeated_restore_failure_stays_pending'],
    100000,
  );
  assertRan(pending, [
    'a_repeated_restore_failure_stays_pending_and_never_reports_convergence',
  ]);

  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': after tmux health returned, a reapply from a ' +
      'reconstructed EnvManager restored MODE=default and unset the originally ' +
      'absent ABSENT, releasing both baselines; the recorded binding survived ' +
      'an Agent restart; repeated failures stayed status=error, never in-sync',
  });
  return 'A later healthy reapply recovers the exact base value across EnvManager reconstruction while repeated failure stays explicitly pending';
});
