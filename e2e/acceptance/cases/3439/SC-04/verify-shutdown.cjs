'use strict';
// #3439 SC-04 / W3: listener shutdown settles every upgraded WebSocket task
// before it reports closed and before the terminal backends are closed.
const { run, targetSha, assertRan, crateTests } = require('../../../shared/control-mode-cases.cjs');

const TEST =
  'server::websocket::tests::listener_shutdown_settles_upgraded_connections_before_wait_closed';

run(({ evidence }) => {
  const sha = targetSha();
  const agent = crateTests(
    'nession-agent',
    ['--lib', 'listener_shutdown_settles'],
    600_000,
  );
  assertRan(agent, [TEST]);

  evidence.push({
    type: 'runtime',
    value:
      sha +
      ': an authenticated and an upgraded-but-pending Agent socket were both settled by listener ' +
      'shutdown, wait_closed returned only after they closed, and the stopped listener reported ' +
      'zero admission capacity',
  });
  return (
    'The Agent listener owns its upgraded connection tasks: shutdown cancels them, settles their ' +
    'lanes and writers, and exposes a completion barrier before backends close'
  );
});
