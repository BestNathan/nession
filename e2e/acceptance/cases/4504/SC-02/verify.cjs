'use strict';
// #4504 SC-02: on staging, the process-level outbound/stream budgets are
// enforced on the real Outbound producers: three independent connections share
// one process ceiling, the local class still has room when the process refuses,
// Control keeps its reserved share, ownership transfer does not double-charge,
// and an omitted reservation charges nothing. The mutation/stream lanes carry
// their own process worker budgets.
const { run, targetSha, assertRan, crateTests } = require('../../../shared/control-mode-cases.cjs');

const RUNTIME = [
  'process_limits_are_hard_and_reserve_control_capacity',
  'process_accounting_aggregates_across_connections',
  'ownership_transfer_does_not_double_charge_the_process_budget',
  'a_process_reservation_refusal_charges_nothing',
];
const AGENT = ['the_process_mutation_lane_is_worker_bounded'];
const SERVER = ['the_process_mutation_lane_is_worker_bounded'];

run(({ evidence }) => {
  const sha = targetSha();
  for (const test of RUNTIME) {
    assertRan(crateTests('nession-runtime', ['--lib', test], 900_000), [test]);
  }
  for (const test of AGENT) {
    assertRan(crateTests('nession-agent', ['--lib', test], 900_000), [test]);
  }
  for (const test of SERVER) {
    assertRan(crateTests('nession-server', ['--lib', test], 900_000), [test]);
  }
  evidence.push({
    type: 'runtime',
    value:
      sha +
      ': three independent Outbound connections shared one enforced process ceiling, the ' +
      'refusing connection kept local class room and Control kept its reserve, ownership ' +
      'transfer did not double-charge, an omitted reservation charged nothing, and both ' +
      'process execution lanes are worker-bounded',
  });
  return (
    'The process aggregate outbound/stream budget is enforced across independent connections ' +
    'with Control reserved, the refused submission charges nothing, ownership transfer is not ' +
    'double-charged, and the process execution lanes are worker-bounded'
  );
});
