'use strict';
// #2811 SC-01: a CLI default attach must use the second advertised P2P address
// when the first is unreachable. The runtime test starts a real Server and a
// real Agent listener, advertises a dead endpoint first and the live one
// second, then resolves the CLI's default (`auto`) route and completes the
// agent.attach handshake on the returned transport.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  run,
  targetSha,
  crateTests,
  assertRan,
} = require('../../../shared/control-mode-cases.cjs');

const TEST = 'attach_route::sc01_auto_attach_uses_the_second_advertised_p2p_candidate';

// The test owns its private tmux socket so it can never reach the runner's
// shared tmux server.
const tmuxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-2811-sc01-'));
const tmuxEnv = { NESSION_TMUX_SOCKET: path.join(tmuxDir, 'tmux.sock') };

run(({ evidence }) => {
  const sha = targetSha();

  const output = crateTests(
    'nession-cli',
    ['--test', 'integration', 'sc01_'],
    600000,
    tmuxEnv,
  );
  assertRan(output, [TEST]);

  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': the Server advertised an unreachable endpoint first and the ' +
      'live Agent listener second; the CLI default route dialled the first, recorded the ' +
      'failure, dialled the second, returned a P2P route naming that second URL, and the ' +
      'real Agent acknowledged the resulting agent.attach for the same session',
  });
  return 'The CLI default attach reaches the live Session through the second advertised P2P address';
});
