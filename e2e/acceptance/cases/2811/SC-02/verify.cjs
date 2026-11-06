'use strict';
// #2811 SC-02: when every direct candidate fails but the Server relay is
// available, auto reaches the Session through the relay; forced P2P never
// switches to relay, and forced relay never dials an Agent address itself.
// A deterministic middlebox refuses the CLI's direct dials and forwards the
// Server's relay dial to the real Agent.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  run,
  targetSha,
  crateTests,
  assertRan,
} = require('../../../shared/control-mode-cases.cjs');

const TESTS = [
  'attach_route::sc02_auto_attach_falls_back_to_relay_when_every_direct_candidate_fails',
  'attach_route::sc02_forced_p2p_reports_an_error_without_relay_fallback',
  'attach_route::sc02_forced_relay_does_not_attempt_p2p',
];

const tmuxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-2811-sc02-'));
const tmuxEnv = { NESSION_TMUX_SOCKET: path.join(tmuxDir, 'tmux.sock') };

run(({ evidence }) => {
  const sha = targetSha();

  const output = crateTests(
    'nession-cli',
    ['--test', 'integration', 'sc02_'],
    900000,
    tmuxEnv,
  );
  assertRan(output, TESTS);

  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': with two direct candidates refused by a deterministic ' +
      'middlebox, the CLI default requested a fresh Server relay attach, sent ' +
      'server.session.relay.begin, received the Server relay-ready receipt, and the real ' +
      'Agent returned terminal output containing the echoed marker through the relay; the ' +
      'middlebox counted exactly two refused direct dials followed by the Server relay dial',
  });
  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': forced P2P over the same two refused candidates returned an ' +
      'actionable bounded error naming both attempts and the relay recovery, and the ' +
      'middlebox counted no relay dial; forced relay opened exactly one Server relay dial, ' +
      'made no direct P2P dial, and reached the same Agent session through the relay',
  });
  return 'Auto falls back to Server Relay; forced P2P and forced Relay stay within their route families';
});
