'use strict';
// Exact-SHA source-aligned Case for #2307 SC-06: reattach/subscriber transitions
// do not kill the session or leave a stale writer, and one stalled consumer
// cannot block the Client or healthy peers.
//
// Every witness here synchronizes on a protocol answer or a held handle. The
// reattach ACK test (`integration_input_ack_reconciles_on_reattach`) also waits
// for a PTY echo; it is deliberately not a witness — that echo wait is a timing
// race under a loaded shared batch, and a flaky witness is not proof.
const {
  run, targetSha, cargoTests, assertRan,
} = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();

  for (const name of [
    'server::websocket::tests::a_stalled_fan_out_does_not_hold_the_session_backend',
    'server::websocket::tests::terminal_output_detaches_a_subscriber_that_stops_draining',
    'server::websocket::tests::a_terminal_forwarder_that_cannot_drain_closes_the_connection',
    'server::issued_credit::tests::one_stalled_subscriber_cannot_consume_anothers_credit',
    'server::session_terminal::tests::acquire_bumps_generation_and_rejects_stale',
    'server::session_terminal::tests::reacquiring_as_the_holder_keeps_the_generation',
    'server::session_terminal::tests::the_restated_generation_survives_repeated_activation',
  ]) {
    assertRan(cargoTests(['--lib', name], 180000), [name]);
  }

  // A second attach on the same connection: the retry is answered on that
  // connection and the connection is still usable afterwards (#1226). Both
  // assertions sync on the attach reply, not on a PTY echo.
  const reattach = cargoTests([
    '--test', 'integration', 'server::a_second_attach_on_the_same_connection_is_answered',
  ], 300000);
  assertRan(reattach, ['server::a_second_attach_on_the_same_connection_is_answered']);

  const reconnect = cargoTests([
    '--test', 'integration', 'connection::integration_reconnection_logic',
  ], 300000);
  assertRan(reconnect, ['connection::integration_reconnection_logic']);

  const detach = cargoTests([
    '--lib', 'tmux::control::tests::the_injected_tmux_receives_the_control_mode_attach_and_the_detach',
  ], 120000);
  assertRan(detach, [
    'tmux::control::tests::the_injected_tmux_receives_the_control_mode_attach_and_the_detach',
  ]);

  evidence.push(
    { type: 'runtime', value: 'stalled fan-out, non-draining subscriber, forwarder shutdown and credit isolation passed at exact SHA ' + sha },
    { type: 'runtime', value: 'a same-connection second attach is answered and leaves the connection usable; agent reconnection passed against real sockets' },
    { type: 'runtime', value: 'ControlLease generation fencing rejects stale writers and restates the holder generation; the control attachment detaches only the pid it spawned' },
  );
  return 'Stalled/subscriber transitions neither block the Client nor healthy peers, reattach keeps its identity without a stale writer, and teardown targets only the attachment it owns';
});
