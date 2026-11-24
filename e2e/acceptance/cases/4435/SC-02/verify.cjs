'use strict';
// #4435 SC-02: on staging, the terminal stream path over P2P and Relay keeps
// reliable input order and ACK/reconcile semantics under blocked ordinary
// requests, replays/checkpoints on reconnect, refuses gaps and stale epochs
// without writing, and never writes a retried frame twice.
const { run, targetSha, assertRan, crateTests } = require('../../../shared/control-mode-cases.cjs');

const AGENT = [
  'server::a_plain_second_attach_sends_bootstrap_before_ok_when_asked',
  'server::integration_an_unsequenced_sender_still_writes',
  'server::integration_input_ack_reconciles_on_reattach',
  'server::integration_a_retried_input_frame_is_not_written_twice',
  'server::integration_a_gap_and_a_stale_epoch_are_refused_without_writing',
  'server::a_sessions_frames_are_applied_in_order',
];
const SERVER = [
  'relay::relay_attach_and_terminal_io',
  'relay::relay_carries_the_input_ack_to_the_browser',
];

run(({ evidence }) => {
  const sha = targetSha();
  for (const test of AGENT) {
    assertRan(crateTests('nession-agent', ['--test', 'integration', test], 900_000), [test]);
  }
  for (const test of SERVER) {
    assertRan(crateTests('nession-server', ['--test', 'integration', test], 900_000), [test]);
  }
  evidence.push({
    type: 'runtime',
    value:
      sha +
      ': bootstrap-before-ok, legacy unsequenced input, ACK reconcile on reattach, idempotent ' +
      'retry, gap/stale-epoch refusal, in-order session input, Relay attach/IO and the Relay ' +
      'input-ACK path all passed',
  });
  return (
    'Reliable terminal input is ordered and never silently lost or blindly replayed; output ' +
    'recovery uses the existing cursor/ACK semantics across P2P and Relay; a gap or stale epoch ' +
    'is refused without writing; a reconnect reconciles the cursor and does not duplicate input'
  );
});
