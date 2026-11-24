'use strict';
// #4433 SC-03: the three WS ingress roles (Server client socket, Agent central
// connection, Agent peer-to-peer socket) keep control/response progress under
// blocked request work, fence auth/relay transitions, and retain same-session
// FIFO across central and P2P paths. A saturated lane refuses explicitly
// instead of parking the reader; a stale identity never accepts work.
const { run, targetSha, assertRan, crateTests } = require('../../../shared/control-mode-cases.cjs');

const SERVER = [
  'websocket::registration_is_ordered_before_the_state_the_agent_reports',
  'websocket::a_mutation_is_not_held_behind_a_slow_query',
  'websocket::mutations_of_one_session_are_ordered_across_connections',
];
const AGENT = ['server::two_peers_mutating_one_session_are_ordered'];
const AGENT_LIB = [
  'connection::server_client::tests::the_central_connection_refuses_past_its_bound_and_drains',
];
const RUNTIME_LIB = ['lane::tests::a_full_query_lane_refuses_without_waiting'];

run(({ evidence }) => {
  const sha = targetSha();
  for (const test of SERVER) {
    assertRan(crateTests('nession-server', ['--test', 'integration', test], 900_000), [test]);
  }
  for (const test of AGENT) {
    assertRan(crateTests('nession-agent', ['--test', 'integration', test], 900_000), [test]);
  }
  for (const test of AGENT_LIB) {
    assertRan(crateTests('nession-agent', ['--lib', test], 900_000), [test]);
  }
  for (const test of RUNTIME_LIB) {
    assertRan(crateTests('nession-runtime', ['--lib', test], 900_000), [test]);
  }
  evidence.push({
    type: 'runtime',
    value:
      sha +
      ': Server registration ordering, independent mutation/probe progress, cross-connection ' +
      'same-session FIFO, Agent P2P same-session FIFO, central-connection explicit refusal and ' +
      'non-waiting reader admission all passed on the three ingress roles',
  });
  return (
    'All three WS ingress roles admit without parking on business permits, refuse saturation ' +
    'explicitly, fence auth/registration ahead of dependent state, and preserve same-session ' +
    'FIFO across central and P2P dispatch without a stale identity accepting work'
  );
});
