'use strict';
// #4434 SC-02: a stalled sink/peer produces a finite write deadline and the
// verdict reaches the read side; no half-open task or registry entry is left;
// a slow peer does not stop another connection. The Server, Agent P2P, Agent
// central and Relay legs are exercised, plus the broker/lifecycle terminal
// outcomes that settle pending work exactly once.
const { run, targetSha, assertRan, crateTests } = require('../../../shared/control-mode-cases.cjs');

const SERVER = [
  'websocket::a_terminal_client_that_stops_draining_is_closed_by_the_bound',
  'websocket::half_open_relay_reports_reason_and_reattaches',
  'websocket::old_connection_disconnect_does_not_unregister_the_new_one',
];
const AGENT_LIB = [
  'server::websocket::tests::a_terminal_forwarder_that_cannot_drain_closes_the_connection',
  'connection::server_client::tests::the_central_connection_refuses_past_its_bound_and_drains',
];
const SERVER_LIB = [
  'server::command_broker::tests::a_timeout_settles_once_and_a_late_reply_cannot_revive_it',
];
const RUNTIME_LIB = [
  'lifecycle::tests::a_stalled_write_returns_a_timeout_rather_than_parking_forever',
];

run(({ evidence }) => {
  const sha = targetSha();
  for (const test of SERVER) {
    assertRan(crateTests('nession-server', ['--test', 'integration', test], 900_000), [test]);
  }
  for (const test of AGENT_LIB) {
    assertRan(crateTests('nession-agent', ['--lib', test], 900_000), [test]);
  }
  for (const test of SERVER_LIB) {
    assertRan(crateTests('nession-server', ['--lib', test], 900_000), [test]);
  }
  for (const test of RUNTIME_LIB) {
    assertRan(crateTests('nession-runtime', ['--lib', test], 900_000), [test]);
  }
  evidence.push({
    type: 'runtime',
    value:
      sha +
      ': Relay stall closed the connection, half-open Agent leg reported and reattached, a ' +
      'disconnected owner did not unregister its successor, the P2P forwarder and central ' +
      'connection closed on their bounds, the broker timeout settled once, and a stalled write ' +
      'returned a finite timeout verdict',
  });
  return (
    'A stalled sink has a finite write deadline whose verdict reaches the read side, half-open ' +
    'and stale-owner settlement is exactly-once, a slow peer is isolated from another ' +
    'connection, and the Server/P2P/central/Relay legs all end rather than leak'
  );
});
