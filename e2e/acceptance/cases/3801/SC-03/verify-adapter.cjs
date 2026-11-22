'use strict';
// #3801 SC-03: Claude exit releases the Pane, a stale PID/conversation cannot
// overwrite the current owner, a recreated Session inherits nothing, and the
// terminal continues through attach/input/resize.
const { run, targetSha, cargoTests, assertRan } = require('../../../shared/control-mode-cases.cjs');

const TESTS = [
  'a_bound_claude_pane_maps_busy_waiting_idle_and_releases_on_exit',
  'a_recreated_session_with_the_same_name_does_not_inherit_activity',
  'a_real_pane_keeps_its_terminal_while_activity_reconciles',
];

run(({ evidence }) => {
  const sha = targetSha();
  const output = cargoTests(['--lib', 'session::activity::'], 110000);
  assertRan(output, TESTS);
  evidence.push({
    type: 'runtime',
    value:
      `exact SHA ${sha}: exiting the bound Claude process released its Pane, ` +
      'a stale PID and an unverified version were owned as unknown rather ' +
      'than carrying a previous state, a recreated same-name Session inherited ' +
      'no Activity, and a real Pane kept attach/input/resize while reconciling',
  });
  return 'Claude exit, stale identity and Session replacement retire the old observation without disturbing the terminal';
});
