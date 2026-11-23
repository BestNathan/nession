'use strict';
// Shared machinery for the Session Activity Cases (#3800/#3802).
//
// The Shell provider needs a real tmux Pane (its evidence is the Pane root's
// process groups), so every verifier gives the cargo test binary its own tmux
// socket and removes the directory afterwards. The tests are `--lib` tests:
// the Acceptance Case runtime has run real-tmux library tests, while a nested
// integration-test binary has hung there before.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cargoTests, assertRan } = require('./control-mode-cases.cjs');

/**
 * Run one filtered nession-agent `--lib` test set against a private tmux
 * socket and assert every named test actually reported a pass.
 */
function runSessionActivityTests(filter, tests) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-activity-case-'));
  try {
    const output = cargoTests(['--lib', filter], 90000, {
      NESSION_TMUX_SOCKET: path.join(dir, 'tmux.sock'),
    });
    assertRan(output, tests);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { runSessionActivityTests };
