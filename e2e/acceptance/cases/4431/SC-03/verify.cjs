'use strict';
// #4431 SC-03: on integrated staging, control completion, independent requests
// and terminal streaming progress together under bounded saturation; excess
// work is refused explicitly, ordered frames still fence, task growth is
// bounded at the connection/key bounds, and a non-draining client is closed by
// the stream bound rather than buffered without limit or lost silently.
const { run, targetSha, assertRan, crateTests } = require('../../../shared/control-mode-cases.cjs');

const SERVER = [
  'websocket::registration_is_ordered_before_the_state_the_agent_reports',
  'websocket::two_queries_waiting_on_an_agent_run_at_the_same_time',
  'websocket::the_query_lane_refuses_past_its_bound_and_settles',
  'websocket::a_client_naming_many_resources_gets_workers_for_a_bounded_number_of_them',
  'websocket::a_terminal_client_that_stops_draining_is_closed_by_the_bound',
];
const AGENT = [
  'server::a_sessions_frames_are_applied_in_order',
  'server::a_peer_naming_many_sessions_gets_workers_for_a_bounded_number_of_them',
  // The simultaneous mixed-load proof (#4431 SC-03): one window, saturated
  // ordinary Request admission, with control, terminal attach/input and
  // terminal output all progressing and excess requests refused explicitly.
  'server::a_saturated_request_lane_does_not_delay_control_or_terminal_input',
];

run(({ evidence }) => {
  const sha = targetSha();
  for (const test of SERVER) {
    assertRan(crateTests('nession-server', ['--test', 'integration', test], 900_000), [test]);
  }
  for (const test of AGENT) {
    assertRan(crateTests('nession-agent', ['--test', 'integration', test], 900_000), [test]);
  }
  evidence.push({
    type: 'runtime',
    value:
      sha +
      ': control/registration ordering, independent queries, explicit overload refusal, ' +
      'bounded per-connection/key workers, ordered terminal frames, the stream stall verdict, and ' +
      'a simultaneous mixed-load window where saturated ordinary admission did not delay ' +
      'control, attach/input or terminal output',
  });
  return (
    'Mixed control/request/stream load is bounded and explicit: independent queries overlap, ' +
    'saturated admission is refused rather than silently dropped, ordered registration fences ' +
    'dependent state, per-resource worker counts stay bounded, terminal frames are applied in ' +
    'order, and a client that stops draining is closed by the stream bound'
  );
});
