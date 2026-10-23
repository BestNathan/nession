'use strict';
// Exact-SHA source-aligned Case for #2307 SC-06: reattach/subscriber transitions
// do not kill the session or leave a stale writer, and one stalled consumer
// cannot block the Client or healthy peers.
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
  ]) {
    assertRan(cargoTests(['--lib', name], 180000), [name]);
  }

  const reattach = cargoTests([
    '--test', 'integration', 'integration_input_ack_reconciles_on_reattach',
  ], 300000);
  assertRan(reattach, ['integration_input_ack_reconciles_on_reattach']);

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
    { type: 'runtime', value: 'stalled fan-out, non-draining subscriber and credit isolation tests passed at exact SHA ' + sha },
    { type: 'runtime', value: 'reattach input/ACK reconciliation and agent reconnection passed against real sockets' },
    { type: 'runtime', value: 'the control attachment detaches the client it spawned by pid, not the session or a peer client' },
  );
  return 'Stalled/subscriber transitions neither block the Client nor healthy peers, and teardown targets only the attachment it owns';
});
