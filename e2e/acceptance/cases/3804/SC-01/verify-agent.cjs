'use strict';
// #3804 SC-01 (agent half): the Agent publishes a level on its own wire with
// the Session incarnation, Agent epoch, generation and owning capability.
const { run, targetSha, cargoTests, assertRan } = require('../../../shared/control-mode-cases.cjs');

const TEST = 'activity_is_published_on_change_and_restated_by_a_full_resync';

run(({ evidence }) => {
  const sha = targetSha();
  const output = cargoTests(['--lib', 'sync::session_watcher::enumeration_failure::activity_is_published'], 90000);
  assertRan(output, [TEST]);
  evidence.push({
    type: 'runtime',
    value:
      `exact SHA ${sha}: the Agent published the first level as ` +
      'server.agent.session-activity with state working, instance inc-1, ' +
      'capability fixture-shell, generation 1 and a non-empty Agent epoch, ' +
      'on an outbox key separate from the Session inventory',
  });
  return 'The Agent publishes a fenced Activity level beside, not inside, the Session inventory';
});
