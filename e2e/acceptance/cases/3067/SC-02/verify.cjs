'use strict';
// #3067 SC-02: an Agent that remains Offline is still fully deletable —
// registry, SQLite Agent/Session rows, Environment Binding/observed state and
// control channel — and the same agent id can register normally afterwards.
const {
  run,
  targetSha,
  crateTests,
  assertRan,
} = require('../../../shared/control-mode-cases.cjs');

const TEST =
  'agent_delete_race::sc02_offline_deletion_removes_all_state_and_allows_reregistration';

run(({ evidence }) => {
  const sha = targetSha();
  const output = crateTests(
    'nession-server',
    ['--test', 'integration', 'agent_delete_race::sc02_'],
    300000,
  );
  assertRan(output, [TEST]);
  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': deleting a still-Offline Agent removed its registry entry, ' +
      'SQLite Agent and Session rows, Environment Binding and observed state; a fresh ' +
      'registration of the same id was then accepted Online with its own persisted row',
  });
  return 'A still-offline Agent is fully deletable and can register normally afterwards';
});
