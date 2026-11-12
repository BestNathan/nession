'use strict';
// #3067 SC-01: a deletion that observed Offline must not erase a registration
// that completed first, and the delete handler must take the same per-Agent
// gates a registration and heartbeat recovery take, so a registration that
// arrives during the claim waits and applies as a new incarnation afterwards.
const {
  run,
  targetSha,
  crateTests,
  assertRan,
} = require('../../../shared/control-mode-cases.cjs');

const TESTS = [
  'agent_delete_race::sc01_registration_that_completed_first_is_not_erased',
  'agent_delete_race::sc01_deletion_claim_orders_a_concurrent_registration',
  'agent_delete_race::sc01_delete_handler_waits_for_the_registration_gate',
  'agent_delete_race::sc01_delete_handler_waits_for_the_liveness_gate',
];

run(({ evidence }) => {
  const sha = targetSha();
  const output = crateTests(
    'nession-server',
    ['--test', 'integration', 'agent_delete_race::sc01_'],
    300000,
  );
  assertRan(output, TESTS);
  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': the real delete handler + AgentRegistry + CommandBroker ' +
      'refused a deletion after a completed registration (Online, SQLite row and Session ' +
      'survived), parked a registration behind the deletion claim and the registration gate, ' +
      'and parked the destructive transition on the liveness gate before any write',
  });
  return 'A pending Agent deletion cannot erase a newer registration, and it is ordered by the shared gates';
});
