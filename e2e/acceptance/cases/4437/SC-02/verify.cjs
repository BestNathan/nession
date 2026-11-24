'use strict';
// #4437 SC-02: on staging, a mixed runtime workload emits bounded
// runtime/domain/result/reason telemetry through a local test collector,
// covers admission, completion, timeout, saturation, coalescence, broker
// outcomes and reconnect; identifier-free labels and schema/dashboard
// agreement hold; and a failed/stalled collector drops metrics instead of
// blocking the message path.
const { run, targetSha, assertRan, crateTests } = require('../../../shared/control-mode-cases.cjs');

const RUNTIME_LIB = [
  'metrics::tests::labels_are_only_the_bounded_vocabulary',
  'metrics::tests::dashboards_reference_declared_metrics_and_bounded_labels',
  'metrics::tests::a_stalled_exporter_drops_and_counts_instead_of_blocking',
  'lifecycle::tests::a_write_timeout_and_settlement_emit_bounded_telemetry',
  'ingress::tests::connection_attempts_and_active_are_emitted_across_reconnects',
  'lane::tests::a_full_query_lane_refuses_without_waiting',
];
const SERVER_LIB = ['server::command_broker::tests::pending_outcomes_emit_bounded_telemetry'];
const AGENT_LIB = ['connection::outbox::tests::coalescing_emits_the_stream_coalesced_metric'];

run(({ evidence }) => {
  const sha = targetSha();
  const baseline = crateTests(
    'nession-runtime',
    ['--test', 'ws_runtime_baseline'],
    600_000,
  );
  assertRan(baseline, ['a_controlled_load_baseline_is_reproducible_and_settles']);
  for (const test of RUNTIME_LIB) {
    assertRan(crateTests('nession-runtime', ['--lib', test], 600_000), [test]);
  }
  for (const test of SERVER_LIB) {
    assertRan(crateTests('nession-server', ['--lib', test], 600_000), [test]);
  }
  for (const test of AGENT_LIB) {
    assertRan(crateTests('nession-agent', ['--lib', test], 600_000), [test]);
  }
  evidence.push({
    type: 'runtime',
    value:
      sha +
      ': the mixed-load baseline settled with owner-emitted admission/outbound/task/duration ' +
      'counters and gauges; bounded labels, dashboard/catalog agreement, stalled-collector drops, ' +
      'write-timeout and settlement reasons, reconnect attempts/active, lane refusal, broker ' +
      'outcomes and stream coalescence all held',
  });
  return (
    'A mixed runtime workload emits bounded, identifier-free telemetry covering admission, ' +
    'completion, timeout, saturation, broker outcomes, reconnect and stream coalescence; a ' +
    'stalled local collector drops and counts metrics without blocking the message path; and ' +
    'the versioned dashboards agree with the emitted catalog'
  );
});
