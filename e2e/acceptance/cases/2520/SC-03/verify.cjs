'use strict';
// #2520 SC-03: the production topology behind the test socket — one Agent,
// one tmux server, several Sessions created at different widths — keeps each
// Session's width independent through create, attach and an authorized
// row-only resize. A test-only isolation fix would not prove this; a real
// Agent, real tmux and the real ControlLease do.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  run, targetSha, cargoTests, assertRan, tmuxVersion,
} = require('../../../shared/control-mode-cases.cjs');

const tmuxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-2520-sc03-'));
const tmuxEnv = { NESSION_TMUX_SOCKET: path.join(tmuxDir, 'tmux.sock') };

const TEST = 'server::shared_agent_keeps_independent_session_widths';
const REPEATS = 2;

run(({ evidence }) => {
  const sha = targetSha();
  const version = tmuxVersion();

  for (let i = 0; i < REPEATS; i += 1) {
    const output = cargoTests(['--test', 'integration', TEST], 300000, tmuxEnv);
    assertRan(output, [TEST]);
  }

  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ' on ' + version + ': ' + REPEATS +
      'x one Agent on one tmux server created an 80-column and a 96-column ' +
      'Session, both attach replies stated their own width, an authorized ' +
      'resize on the 96-column Session applied rows only, and the 80-column ' +
      'Session was unchanged',
  });
  return 'Multi-Session sharing keeps independent configured widths; no product regression is proven';
});
