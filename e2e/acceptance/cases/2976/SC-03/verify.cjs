'use strict';
// #2976 SC-03: a reconnect request that arrives while an older full resync is
// publishing must survive that older attempt's success. The real watcher keeps
// the newer intent owed and serves it on the next poll; the real Server handler
// accepts the complete snapshot for the current connection.
const {
  run, targetSha, crateTests, assertRan,
} = require('../../../shared/control-mode-cases.cjs');

const WATCHER =
  'sync::session_watcher::publication_failure::' +
  'a_reconnect_request_during_resync_is_not_cleared_by_the_older_attempt';
const SERVER_REGISTRY =
  'server::handler::tests::server_agent_session_update_v1::' +
  'a_non_gone_update_keeps_the_desired_environment_binding';

run(({ evidence }) => {
  const sha = targetSha();

  const watcher = crateTests('nession-agent', ['--lib', WATCHER], 600000);
  assertRan(watcher, [WATCHER]);

  const server = crateTests('nession-server', ['--lib', SERVER_REGISTRY], 600000);
  assertRan(server, [SERVER_REGISTRY]);

  evidence.push(
    {
      type: 'runtime',
      value:
        'exact SHA ' + sha + ': a newer reconnect request marked while the older ' +
        'snapshot publish succeeded stayed owed — the older attempt could not clear ' +
        'it — and the next poll published the complete current snapshot and then ' +
        'settled with no further full snapshot',
    },
    {
      type: 'runtime',
      value:
        'exact SHA ' + sha + ': the real server.agent.session-update handler accepted ' +
        'the complete session snapshot and registered the Session',
    },
  );
  return 'A reconnect request arriving during an older resync survives it and the latest attempt publishes the complete snapshot';
});
