'use strict';
// #2997 SC-02: an Agent that stays continuously Offline for the full grace
// interval is still cleaned, but only its eligible Sessions and Environment
// Binding state are removed; recovery concurrent with the destructive boundary
// cannot erase the Session it restores. Both tests run against the real
// registry/Session/SQLite store and the production cleanup owner.
const {
  run,
  targetSha,
  crateTests,
  assertRan,
} = require('../../../shared/control-mode-cases.cjs');

const CONTINUOUS_CLEANUP =
  'offline_grace::sc02_continuous_offline_cleanup_removes_only_that_agents_sessions_and_bindings';
const BOUNDARY_RECOVERY =
  'offline_grace::sc02_recovery_at_the_cleanup_boundary_keeps_the_restored_session';

run(({ evidence }) => {
  const sha = targetSha();

  const output = crateTests(
    'nession-server',
    ['--test', 'integration', 'offline_grace::sc02_'],
    300000,
  );
  assertRan(output, [CONTINUOUS_CLEANUP, BOUNDARY_RECOVERY]);

  evidence.push(
    {
      type: 'runtime',
      value:
        'exact SHA ' + sha + ': a continuously offline Agent\'s expired episode ' +
        'cleanup removed its Session from the registry and SQLite and cleared its ' +
        'desired and observed Environment Binding state, while a second Agent\'s ' +
        'Session and binding state remained untouched',
    },
    {
      type: 'runtime',
      value:
        'exact SHA ' + sha + ': with the expired-episode claim held, a concurrent ' +
        'recovery heartbeat and Session resync waited at the liveness boundary; the ' +
        'cleanup removed the stale Session, and the Session restored by the recovery ' +
        'after the boundary survived',
    },
  );
  return 'Continuous-offline cleanup is scoped to the Agent, and boundary recovery keeps its restored Session';
});
