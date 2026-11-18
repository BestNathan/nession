'use strict';
// #3801 SC-01: a verified Claude owner bound to a real Pane follows fixture
// busy → idle → busy without relying on terminal output or attachment, and a
// foreground command named `claude` alone never produces working.
const { run, targetSha, cargoTests, assertRan } = require('../../../shared/control-mode-cases.cjs');

const TEST = 'a_bound_claude_pane_maps_busy_waiting_idle_and_releases_on_exit';

run(({ evidence }) => {
  const sha = targetSha();
  const output = cargoTests(
    ['--lib', 'session::activity::claude::runtime_tests::'],
    110000,
  );
  assertRan(output, [TEST]);
  evidence.push({
    type: 'runtime',
    value:
      `exact SHA ${sha}: a real tmux Pane running a CLI-compatible Claude ` +
      'fixture was bound by PID and its Nession Activity followed the ' +
      'verified busy → idle → busy answers (then waiting and idle again) via ' +
      'the Agent status reader, not terminal output or attachment',
  });
  return 'A verified Claude PID moves its Pane between working and idle as its own status changes';
});
