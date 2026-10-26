'use strict';
// #2464 SC-01: a screen-only bootstrap restores the pane's caret.
//
// The real-tmux witness parks a live pane's cursor on an empty row and checks
// the wire bytes carry an absolute placement for that row; the unit witnesses
// pin the trimming floor and the one-based conversion the placement needs.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  run, targetSha, cargoTests, assertRan,
} = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  // The real-tmux fixture owns its server: the Case runtime's own tmux socket
  // is not this test's, and inheriting it let the server disappear between
  // session creation and the first send-keys in CI.
  const socketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-2464-sc01-'));
  const tmuxEnv = { NESSION_TMUX_SOCKET: path.join(socketDir, 'tmux.sock') };

  const caret = 'server::a_plain_bootstrap_restores_a_caret_the_pane_left_on_an_empty_row';
  assertRan(cargoTests(['--test', 'integration', caret], 300000, tmuxEnv), [caret]);

  for (const name of [
    'server::bootstrap::tests::a_cursor_on_an_empty_row_keeps_that_row_and_its_terminator',
    'server::bootstrap::tests::a_cursor_past_the_captured_rows_keeps_the_whole_capture',
    'server::bootstrap::tests::the_cursor_escape_is_one_based_and_absolute',
  ]) {
    assertRan(cargoTests(['--lib', name], 180000, tmuxEnv), [name]);
  }
  fs.rmSync(socketDir, { recursive: true, force: true });

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
