'use strict';
// #2976 SC-02: a failed `gone` enqueue during full resync must be retried. The
// real watcher keeps the absent Session tracked until its removal is accepted,
// preserves the surviving live Session, and clears the intent only after an
// all-success snapshot — so the next poll is incremental, not a redundant full
// snapshot. The real Server handler removes exactly the gone Session.
const {
  run, targetSha, crateTests, assertRan,
} = require('../../../shared/control-mode-cases.cjs');

const WATCHER =
  'sync::session_watcher::publication_failure::' +
  'a_failed_gone_enqueue_during_resync_retries_and_removes_only_the_absent_session';
const SERVER_REMOVAL =
  'server::handler::tests::server_agent_session_update_v1::' +
  'session_update_gone_removes_session';

run(({ evidence }) => {
  const sha = targetSha();

  const watcher = crateTests('nession-agent', ['--lib', WATCHER], 600000);
  assertRan(watcher, [WATCHER]);

  const server = crateTests('nession-server', ['--lib', SERVER_REMOVAL], 600000);
  assertRan(server, [SERVER_REMOVAL]);

  evidence.push(
    {
      type: 'runtime',
      value:
        'exact SHA ' + sha + ': with tracked Sessions dev+api and dev absent after ' +
        'reconnect, the surviving api update was accepted while the injected dev gone ' +
        'failure kept the intent owed and both Sessions tracked; the recovery poll ' +
        'published api and the dev gone, cleared the intent, and the following poll ' +
        'published no redundant full snapshot',
    },
    {
      type: 'runtime',
      value:
        'exact SHA ' + sha + ': the real server.agent.session-update handler removed ' +
        'the gone Session from the registry while the surviving Session remained ' +
        'registered',
    },
  );
  return 'A failed removal is retried; only the truly absent Session is removed and the surviving Session stays visible';
});
