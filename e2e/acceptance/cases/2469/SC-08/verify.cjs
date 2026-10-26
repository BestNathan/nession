'use strict';
// #2469 SC-08: one Agent stream timeline under bursts, slow peers and routes.
//
// At the merged staging SHA this Case proves:
//   - burst frames merge into the same sequenced stream, and a burst with a
//     hole, an unmergeable frame or an unsequenced sender is forwarded whole;
//   - a slow/stopped subscriber is detached without stalling a healthy peer or
//     the session's backend;
//   - resume/checkpoint and input-ACK reconciliation still state truthful
//     positions after reattach;
//   - the Relay only mints a subscription proof from an Agent-attested pair and
//     carries the Agent's control lease;
//   - the bootstrap capture and live stream join exactly.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  run, targetSha, checked, cargoTests, assertRan, tmuxVersion,
} = require('../../../shared/control-mode-cases.cjs');

// Own the Agent's process-wide tmux socket: lazy resolution does not create
// the directory, and the Acceptance runner's home need not have one.
const tmuxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-2469-sc08-'));
const tmuxEnv = { NESSION_TMUX_SOCKET: path.join(tmuxDir, 'tmux.sock') };

run(({ evidence }) => {
  const sha = targetSha();
  const version = tmuxVersion();

  const server = checked(
    'cargo',
    ['test', '-p', 'nession-server', '--lib', 'server::websocket::tests', '--', '--nocapture'],
    300000,
    tmuxEnv,
  );
  assertRan(server, [
    'a_merged_burst_states_the_range_it_covers',
    'a_burst_with_a_hole_is_forwarded_whole',
    'a_burst_that_cannot_be_merged_is_forwarded_whole',
    'an_unsequenced_burst_merges_and_states_no_position',
    'relay_ready_carries_the_agents_control_lease_when_stated',
    'relay_subscription_proof_is_never_minted_from_legacy_or_invalid_pair',
    'relay_ready_is_never_minted_from_legacy_partial_or_forged_agent_frames',
  ]);

  const bounded = cargoTests(
    ['--lib', 'server::websocket::tests::a_stalled_fan_out_does_not_hold_the_session_backend'],
    300000,
    tmuxEnv,
  );
  assertRan(bounded, [
    'server::websocket::tests::a_stalled_fan_out_does_not_hold_the_session_backend',
  ]);

  const slow = checked(
    'cargo',
    [
      'test', '-p', 'nession-server', '--test', 'integration',
      'websocket::a_client_that_stops_reading_parks_dispatch_and_loses_nothing',
      '--', '--nocapture',
    ],
    300000,
    tmuxEnv,
  );
  assertRan(slow, [
    'websocket::a_client_that_stops_reading_parks_dispatch_and_loses_nothing',
  ]);

  const order = cargoTests(
    ['--test', 'integration', 'server::a_sessions_frames_are_applied_in_order'],
    300000,
    tmuxEnv,
  );
  assertRan(order, ['server::a_sessions_frames_are_applied_in_order']);

  const resumable = cargoTests(
    ['--test', 'integration', 'server::a_resume_states_its_window_and_whether_it_is_complete'],
    300000,
    tmuxEnv,
  );
  assertRan(resumable, ['server::a_resume_states_its_window_and_whether_it_is_complete']);

  const reconciled = cargoTests(
    ['--test', 'integration', 'server::integration_input_ack_reconciles_on_reattach'],
    300000,
    tmuxEnv,
  );
  assertRan(reconciled, ['server::integration_input_ack_reconciles_on_reattach']);

  const cut = cargoTests(
    ['--test', 'integration', 'control_mode::the_bootstrap_capture_and_the_live_stream_join_exactly'],
    300000,
    tmuxEnv,
  );
  assertRan(cut, ['control_mode::the_bootstrap_capture_and_the_live_stream_join_exactly']);

  evidence.push(
    {
      type: 'runtime',
      value:
        'exact SHA ' + sha + ' on ' + version +
        ': bursts merged into one sequenced stream or were forwarded whole on a hole/unmergeable/unsequenced frame',
    },
    {
      type: 'runtime',
      value:
        'a stopped reader was detached without parking the session backend or a healthy peer; frames stayed ordered',
    },
    {
      type: 'runtime',
      value:
        'resume stated its window/completeness, input ACK reconciled on reattach, the bootstrap joined the live stream exactly, and Relay proofs came only from Agent-attested pairs carrying the lease',
    },
  );
  return 'Subscribers share one bounded Agent stream timeline under bursts, slow peers and Relay route changes, with truthful replay/ACK and checkpoint semantics';
});
