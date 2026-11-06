'use strict';
// #2781 SC-03: existing whole-binding replacement, shell prompt-boundary
// convergence and unrelated Session isolation keep working. The regression
// covers both `Some(base)` and `None` failure cases, has a successful
// counterexample, and proves a failure in one Session does not change another
// Session's durable baseline, status or simulated tmux environment.
const {
  run,
  targetSha,
  cargoTests,
  assertRan,
} = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const replacement = cargoTests(
    ['--lib', 'tmux::env::tests::replacing_a_binding_restores'],
    100000,
  );
  assertRan(replacement, [
    'replacing_a_binding_restores_the_captured_base_value_and_unsets_absent_keys',
  ]);

  const refusal = cargoTests(
    ['--lib', 'tmux::env::tests::a_required_tmux_refusal'],
    100000,
  );
  assertRan(refusal, [
    'a_required_tmux_refusal_is_returned_as_an_error_and_recorded',
  ]);

  const isolation = cargoTests(
    ['--lib', 'tmux::env::tests::a_pending_restore_in_one_session'],
    100000,
  );
  assertRan(isolation, [
    'a_pending_restore_in_one_session_does_not_touch_another_session',
  ]);

  const shell = cargoTests(
    ['--lib', 'tmux::env::tests::the_bash_adapter_converges'],
    100000,
  );
  assertRan(shell, [
    'the_bash_adapter_converges_at_the_next_prompt_and_preserves_user_config',
  ]);

  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': whole-binding replacement still restored ' +
      'Some(base) and unset the absent key; a refused required mutation stayed ' +
      'an error; a pending restore in one Session left the other Session ' +
      'managed and independently restorable; the bash adapter converged at the ' +
      'next prompt without a restart',
  });
  return 'Whole-binding replacement, refusal reporting, Session isolation and shell prompt-boundary convergence remain correct alongside the failure-injection regression';
});
