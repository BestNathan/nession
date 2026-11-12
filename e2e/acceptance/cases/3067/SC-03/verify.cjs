'use strict';
// #3067 SC-03: two overlapping delete requests for the same Offline Agent
// settle consistently: exactly one success, the other a truthful not-found, and
// the Agent's state is removed once.
const {
  run,
  targetSha,
  crateTests,
  assertRan,
} = require('../../../shared/control-mode-cases.cjs');

const TEST = 'agent_delete_race::sc03_overlapping_deletes_settle_with_one_success';

run(({ evidence }) => {
  const sha = targetSha();
  const output = crateTests(
    'nession-server',
    ['--test', 'integration', 'agent_delete_race::sc03_'],
    300000,
  );
  assertRan(output, [TEST]);
  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': two concurrent server.agent.delete requests against the same ' +
      'Offline Agent produced exactly one success and one not-found failure, with the registry, ' +
      'SQLite rows and Session state removed once',
  });
  return 'Overlapping deletes settle with one truthful success and no partial duplicate removal';
});
