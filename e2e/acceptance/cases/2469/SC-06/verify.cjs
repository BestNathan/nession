'use strict';
// #2469 SC-06: cleanup is generation-safe and distinguishable.
//
// At the merged staging SHA this Case proves, against one exact checkout:
//   1. a producer whose stream generation was retired cannot write into its
//      successor, and retiring a generation closes its tmux client;
//   2. killing the tmux Session retires the attachment, so a reconnect gets a
//      fresh stream generation instead of a dead one;
//   3. an external kill (the plain PTY's EOF) retires the stream, tells the
//      subscriber, and the reconnect is fresh;
//   4. process shutdown closes every attached backend.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  run, targetSha, cargoTests, assertRan, tmuxVersion,
} = require('../../../shared/control-mode-cases.cjs');

// The Agent's lazy tmux resolution does not create the socket directory, and
// the Acceptance runner's home need not have one. Each Case owns a private
// socket, like the filtered test harness.
const tmuxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-2469-sc06-'));
const tmuxEnv = { NESSION_TMUX_SOCKET: path.join(tmuxDir, 'tmux.sock') };

run(({ evidence }) => {
  const sha = targetSha();
  const version = tmuxVersion();

  const registry = cargoTests(
    ['--lib', 'session::registry::tests'],
    300000,
  );
  assertRan(registry, [
    'a_retired_producers_output_cannot_enter_its_successor',
    'killing_a_session_retires_its_attachment',
    'shutdown_closes_every_attachment',
  ]);

  const killed = cargoTests(
    ['--test', 'integration', 'server::integration_a_killed_session_retires_its_attachment'],
    300000,
    tmuxEnv,
  );
  assertRan(killed, [
    'server::integration_a_killed_session_retires_its_attachment',
  ]);

  const eof = cargoTests(
    ['--test', 'integration', 'server::integration_a_plain_backend_eof_retires_the_stream'],
    300000,
    tmuxEnv,
  );
  assertRan(eof, [
    'server::integration_a_plain_backend_eof_retires_the_stream',
  ]);

  evidence.push(
    {
      type: 'runtime',
      value:
        'exact SHA ' + sha + ' on ' + version +
        ': a retired generation\'s producer was refused, a killed Session and a plain-PTY EOF each retired the attachment and handed the reconnect a fresh stream generation',
    },
    {
      type: 'runtime',
      value:
        'process shutdown closed every attached backend; the retirements closed their tmux clients rather than leaking them',
    },
  );
  return 'Session kill, source loss and shutdown each retire their generation; no stale producer can enter a successor attachment';
});
