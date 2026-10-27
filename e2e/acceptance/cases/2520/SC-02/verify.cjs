'use strict';
// #2520 SC-02: the standalone Agent's configured 96-column Session reads its
// own correct Pane width under the shared-server concurrency the suite
// actually creates (many 80x24 creates and environment updates in flight, a
// real 80x24 client attached to another Session), repeatedly and on one tmux
// server — without serializing tests, weakening the assertion, or retrying a
// failure away.
//
// The concurrency test is the coordinated schedule; the standalone test is the
// original isolated proof. Both run against a private socket owned by this
// Case.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  run, targetSha, cargoTests, assertRan, tmuxVersion,
} = require('../../../shared/control-mode-cases.cjs');

const tmuxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-2520-sc02-'));
const tmuxEnv = { NESSION_TMUX_SOCKET: path.join(tmuxDir, 'tmux.sock') };

const CONCURRENT = 'server::configured_width_survives_shared_server_flood_and_attach';
const STANDALONE = 'server::integration_standalone_agent_uses_its_configured_columns';
const REPEATS = 3;

run(({ evidence }) => {
  const sha = targetSha();
  const version = tmuxVersion();

  // Each repetition is a fresh Agent pair on the same socket: the flood and
  // attached client are the load, not a shared fixture a later run inherits.
  for (let i = 0; i < REPEATS; i += 1) {
    const output = cargoTests(['--test', 'integration', CONCURRENT], 300000, tmuxEnv);
    assertRan(output, [CONCURRENT]);
  }
  for (let i = 0; i < REPEATS; i += 1) {
    const output = cargoTests(['--test', 'integration', STANDALONE], 300000, tmuxEnv);
    assertRan(output, [STANDALONE]);
  }

  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ' on ' + version + ': ' + REPEATS +
      'x configured-96 create under a shared-server flood (8 creates, 20 env ' +
      'vars each) plus a real attached 80x24 client, and ' + REPEATS +
      'x isolated standalone create, all read their own 96-column Pane and no ' +
      'Session moved another Session',
  });
  return 'Configured widths stay correct under the shared-server concurrency the suite creates';
});
