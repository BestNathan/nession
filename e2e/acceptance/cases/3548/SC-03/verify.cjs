'use strict';
// #3548 SC-03: normal and slow-consumer direct P2P/Relay terminal traffic keeps
// frame order, backpressure, bounded closure and reconnection behavior across
// the new adapters.
//
// The Server's real-socket websocket suite drives the Relay end to end: ordered
// forwarding, a slow terminal client closed by the bound, the stall verdict,
// and the generation-fenced reconnect/ownership paths. Every test in that
// target runs; the named ones are the SC's decisive assertions.
const { run, targetSha, assertRan, crateTests } = require('../../../shared/control-mode-cases.cjs');

const TESTS = [
  'websocket::the_relay_forwards_what_the_agent_says_before_it_answers',
  'websocket::a_terminal_client_that_stops_draining_is_closed_by_the_bound',
  'websocket::a_client_that_stops_reading_parks_dispatch_and_loses_nothing',
  'websocket::old_connection_disconnect_does_not_unregister_the_new_one',
];

run(({ evidence }) => {
  const sha = targetSha();
  const server = crateTests(
    'nession-server',
    ['--test', 'integration', 'websocket::'],
    600_000,
  );
  assertRan(server, TESTS);

  evidence.push({
    type: 'runtime',
    value:
      sha +
      ': the real-socket Server websocket suite passed with the shared frame vocabulary: the Relay ' +
      'forwarded Agent frames before its answer, a terminal client that stopped draining was closed ' +
      'by the bound, dispatch stayed parked and lossless instead of unbounded, and a superseded ' +
      'connection could not take its successor\'s agent',
  });
  return (
    'P2P/Relay terminal traffic keeps its order, backpressure, bounded closure and reconnect/ownership ' +
    'semantics through the transport-neutral frame vocabulary'
  );
});
