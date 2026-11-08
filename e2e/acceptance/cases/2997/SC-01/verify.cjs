'use strict';
// #2997 SC-01: an earlier heartbeat-offline grace cleanup must not remove the
// Agent's Sessions or Environment Bindings during a later, independent offline
// interval. The test drives the real registry, Session registry, SQLite binding
// store and the production cleanup owner: Offline(t0) opens episode 1,
// Online(t5) preserves the Session, Offline(t10) opens episode 2, and the t0
// cleanup invoked during episode 2 must stand down while episode 2's own
// expired cleanup still removes the state.
const {
  run,
  targetSha,
  crateTests,
  assertRan,
} = require('../../../shared/control-mode-cases.cjs');

const PRIOR_EPISODE =
  'offline_grace::sc01_prior_episode_cleanup_cannot_remove_sessions_of_a_newer_offline_interval';

run(({ evidence }) => {
  const sha = targetSha();

  const output = crateTests(
    'nession-server',
    ['--test', 'integration', 'offline_grace::sc01_'],
    300000,
  );
  assertRan(output, [PRIOR_EPISODE]);

  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': on one real AgentRegistry + SessionRegistry + SQLite ' +
      'binding store, Offline(t0) opened generation 1 and Online(t5) preserved the ' +
      'Session; Offline(t10) opened a distinct generation 2; the cleanup bound to ' +
      'generation 1 invoked during the second interval removed nothing — registry, ' +
      'SQLite Session row, desired binding and observed binding all remained — and ' +
      'the second episode\'s own expired cleanup then removed them',
  });
  return 'A prior offline interval\'s grace cleanup cannot act on a later interval';
});
