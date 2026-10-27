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
  // The criterion does not ask whether the sharing topology merely looks
  // stable: it asks whether a real product defect exists. One did — on tmux
  // 3.4 a client attached to another Session sized a created Session to its
  // own 80x24 — and `create_session` now applies the requested geometry after
  // `new-session`. #2487's SC-09 invariant is the one that was violated; its
  // reopen evidence is this same shared-server witness, not a test-only
  // isolation change.
  evidence.push({
    type: 'runtime',
    value:
      'the shared-server create defect is found and fixed at the create owner: ' +
      'on tmux 3.4 a client attached to another Session discarded a new ' +
      'Session\'s requested columns; the create path now applies them ' +
      'explicitly; the #2487 SC-09 invariant it violated cannot rest on an ' +
      'isolated path, so this production-equivalent witness is its live ' +
      'evidence',
  });
  return 'Multi-Session sharing keeps independent configured widths; the shared-server create defect behind the original 80x24 failure is fixed at the create owner';
});
