'use strict';
// #4503 SC-02: on staging, ordinary saturation and real-time stream work do
// not share an execution domain. The reserved Stream lane is proven at the
// runtime, the saturated P2P window keeps control, attach/input and terminal
// output alive, per-session order holds, and the Relay transport carries the
// same terminal path.
const { run, targetSha, assertRan, crateTests } = require('../../../shared/control-mode-cases.cjs');

const RUNTIME = ['a_reserved_stream_lane_is_independent_of_mutation_saturation'];
const POLICY = ['terminal_realtime_wires_declare_the_reserved_stream_policy'];
const AGENT = [
  'server::a_saturated_request_lane_does_not_delay_control_or_terminal_input',
  'server::a_sessions_frames_are_applied_in_order',
  'server::two_peers_mutating_one_session_are_ordered',
];
const SERVER = [
  'relay::relay_attach_and_terminal_io',
  'relay::relay_carries_the_input_ack_to_the_browser',
];

run(({ evidence }) => {
  const sha = targetSha();
  for (const test of RUNTIME) {
    assertRan(crateTests('nession-runtime', ['--lib', test], 900_000), [test]);
  }
  for (const test of POLICY) {
    assertRan(crateTests('nession-agent', ['--lib', test], 900_000), [test]);
  }
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
      ': the reserved Stream lane completed while the mutation lane was blocked; a saturated ' +
      'P2P window still answered control, attach and terminal input and delivered terminal ' +
      'output; session attach/input order held across peers; Relay attach/IO and the Relay ' +
      'input ACK passed',
  });
  return (
    'Real-time stream work is admitted into a reserved execution domain: ordinary saturation ' +
    'does not delay terminal attach/input/resize or control, per-session order is preserved, ' +
    'and the Relay transport carries the same terminal path'
  );
});
