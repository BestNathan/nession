'use strict';
// #4435 SC-03: Session resource fences survive kill/recreate, authority/lease
// transfer and stream replacement. Input or resize admitted before a
// replacement is never claimed by/recorded into the successor; a retired
// producer's output cannot enter it; a stale lease is refused without writing;
// current input and resize keep their required order.
const { run, targetSha, assertRan, crateTests } = require('../../../shared/control-mode-cases.cjs');

const AGENT_LIB = [
  'session::registry::tests::input_admitted_before_a_stream_replacement_is_not_claimed',
  'session::registry::tests::resize_admitted_before_a_stream_replacement_is_not_recorded',
  'session::registry::tests::a_retired_producers_output_cannot_enter_its_successor',
  'server::output_ack::tests::replacement_and_epoch_change_revoke_old_ack_provenance',
];
const AGENT = [
  'server::integration_input_from_a_stale_lease_is_refused_without_writing',
  'server::integration_resize_from_a_stale_lease_is_refused_and_tagged',
  'server::integration_a_killed_session_retires_its_attachment',
];

run(({ evidence }) => {
  const sha = targetSha();
  for (const test of AGENT_LIB) {
    assertRan(crateTests('nession-agent', ['--lib', test], 900_000), [test]);
  }
  for (const test of AGENT) {
    assertRan(crateTests('nession-agent', ['--test', 'integration', test], 900_000), [test]);
  }
  evidence.push({
    type: 'runtime',
    value:
      sha +
      ': pre-replacement input/resize was not claimed by the successor, retired output could not ' +
      'enter it, replacement revoked old ACK provenance, stale-lease input/resize were refused ' +
      'without writing, and a killed Session retired its attachment',
  });
  return (
    'Kill/recreate, authority transfer and stream replacement are fenced at the Session owner: ' +
    'stale epochs, leases and generations cannot write to a replacement, a retired producer ' +
    'cannot feed it, and valid current input/resize retain their ordering'
  );
});
