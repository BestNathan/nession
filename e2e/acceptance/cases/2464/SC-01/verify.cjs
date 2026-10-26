'use strict';
// #2464 SC-01: a screen-only bootstrap restores the pane's caret.
//
// The real-tmux witness parks a live pane's cursor on an empty row and checks
// the wire bytes carry an absolute placement for that row; the unit witnesses
// pin the trimming floor and the one-based conversion the placement needs.
const {
  run, targetSha, cargoTests, assertRan,
} = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();

  const caret = 'server::a_plain_bootstrap_restores_a_caret_the_pane_left_on_an_empty_row';
  assertRan(cargoTests(['--test', 'integration', caret], 300000), [caret]);

  for (const name of [
    'server::bootstrap::tests::a_cursor_on_an_empty_row_keeps_that_row_and_its_terminator',
    'server::bootstrap::tests::a_cursor_past_the_captured_rows_keeps_the_whole_capture',
    'server::bootstrap::tests::the_cursor_escape_is_one_based_and_absolute',
  ]) {
    assertRan(cargoTests(['--lib', name], 180000), [name]);
  }

  evidence.push(
    {
      type: 'runtime',
      value:
        'exact SHA ' + sha +
        ': a real tmux pane parked its caret on an empty row and the bootstrap carried the pane\'s absolute placement for it',
    },
    {
      type: 'test',
      value:
        'the trimming floor keeps the cursor row and its terminator; the emitted escape is one-based',
    },
  );
  return 'A screen-only bootstrap restores the pane caret, including when the application paused on a row it never wrote';
});
