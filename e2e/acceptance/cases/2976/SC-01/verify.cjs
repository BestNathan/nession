'use strict';
// #2976 SC-01: after a reconnect, an outbound enqueue failure following a
// successful tmux enumeration must not consume the full-resync intent. The
// real watcher keeps its previous snapshot, and with no new reconnect event a
// later poll republishes the still-live Session into the real outbox; the real
// Server handler registers that Session.
const {
  run, targetSha, crateTests, assertRan,
} = require('../../../shared/control-mode-cases.cjs');

const WATCHER =
  'sync::session_watcher::publication_failure::' +
  'an_enqueue_failure_after_enumeration_keeps_resync_pending_and_republishes_after_recovery';
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
        'exact SHA ' + sha + ': with a tracked Session and a reconnect intent, a ' +
        'successful enumeration followed by an injected enqueue failure published no ' +
        'frame, kept the intent owed and kept tracked_sessions() intact; a later poll ' +
        'with no new reconnect republished the Session into the outbox',
    },
    {
      type: 'runtime',
      value:
        'exact SHA ' + sha + ': the real server.agent.session-update handler registered ' +
        'the re-reported Session in session_registry and kept its desired Environment ' +
        'Binding',
    },
  );
  return 'A failed full-resync enqueue stays pending and the later poll republishes the live Session, which the Server registers';
});
