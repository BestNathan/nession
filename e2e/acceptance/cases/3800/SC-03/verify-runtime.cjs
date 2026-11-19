'use strict';
// #3800 SC-03 (runtime half): a real tmux Session and a real PTY attach keep
// working while the coordinator reconciles their verified identity; a failed
// specialized observation is unknown; killing the Session retires its level.
//
// A `--lib` test with its own socket, not a nested integration binary: the Case
// runtime can run real-tmux library tests, while a separate integration-test
// binary has hung there before.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run, targetSha, cargoTests, assertRan } = require('../../../shared/control-mode-cases.cjs');

const TESTS = ['a_real_pane_keeps_its_terminal_while_activity_reconciles'];

run(({ evidence }) => {
  const sha = targetSha();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-3800-sc03-'));
  try {
    const output = cargoTests(['--lib', 'session::activity::runtime_tests::'], 90000, {
      NESSION_TMUX_SOCKET: path.join(dir, 'tmux.sock'),
    });
    assertRan(output, TESTS);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': a real tmux Session with a real PTY attach accepted ' +
      'input and a resize while Activity reconciled its Pane; a failing specialized ' +
      'probe produced unknown rather than the generic working claim; killing the ' +
      'Session removed its activity from the verified inventory',
  });
  return 'Activity refresh is identity-fenced against the real Pane and leaves terminal attach/input/resize intact';
});
