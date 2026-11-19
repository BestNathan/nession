'use strict';
// #4072 SC-02: while a reconnect attempt is pending on a successfully
// upgraded but silent Server, `shutdown()` cancels the attempt promptly. The
// mock Server observes its socket close well before the 30s attempt deadline,
// and no third connection is opened.
const { run, targetSha, crateTests, assertRan, isolatedTmuxEnv } =
  require('../../../shared/mcp-cases.cjs');

const TEST =
  'connection::server_client::tests::connect_attempt_shutdown_cancels_pending_registration';

run(({ evidence }) => {
  const sha = targetSha();
  const out = crateTests(
    'nession-agent',
    ['--lib', 'connection::server_client::tests::connect_attempt_shutdown_cancels_pending_registration'],
    300000,
    isolatedTmuxEnv('nession-4072-sc02'),
  );
  assertRan(out, [TEST]);

  evidence.push({
    type: 'runtime',
    value:
      'exact staging ' + sha + ': a real Agent registered once, then reconnected to a mock ' +
      'Server that accepted the WS upgrade and never answered registration; shutdown() during ' +
      'that pending attempt closed the socket promptly (well under the 30s deadline) and the ' +
      'supervisor opened no further connection',
  });
  return 'Shutdown cancels a pending registration attempt without waiting for the peer';
});
