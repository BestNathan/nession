'use strict';
// #3062 SC-02: concurrent Session creation, retry/timeout and deletion keep
// image/writable-resource ownership, never duplicate an already-created tmux
// Session or delete another Session's active artifacts, and report truthful
// recoverable state.
const { run, targetSha, crateTests, assertRan } = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const server = crateTests(
    'nession-server',
    ['--lib', 'server::handler::tests::server_session_managed_v1'],
    600000,
  );
  assertRan(server, [
    'server::handler::tests::server_session_managed_v1::a_stale_managed_attempt_cannot_overwrite_the_winner',
    'server::handler::tests::server_session_managed_v1::a_failed_managed_create_is_retryable',
    'server::handler::tests::server_session_managed_v1::a_ready_managed_session_is_not_recreated_by_a_same_named_attempt',
    'server::handler::tests::server_session_managed_v1::deleting_one_managed_context_keeps_another_sessions',
  ]);
  const agent = crateTests('nession-agent', ['--lib', 'managed_session::tests'], 600000);
  assertRan(agent, [
    'managed_session::tests::managed_prepare_downloads_pins_and_builds_the_composition',
  ]);
  const cache = crateTests(
    'nession-erofs',
    ['--features', 'cache', '--lib', 'cache::tests::concurrent_'],
    600000,
  );
  assertRan(cache, [
    'cache::tests::concurrent_callers_share_one_fetch_per_digest',
  ]);
  const reconciliation = crateTests(
    'nession-server',
    ['--lib', 'db::tests::managed_context'],
    600000,
  );
  assertRan(reconciliation, [
    'db::tests::managed_context_reconciliation_keeps_an_in_flight_preparation',
  ]);
  evidence.push(
    {
      type: 'runtime',
      value:
        'exact SHA ' + sha + ': a losing attempt could not overwrite the winning attempt\'s ' +
        'ready managed context; a same-named attempt against a ready Session was refused ' +
        'before reaching the Agent and left the winner\'s attempt, workspace and status ' +
        'intact; a refused attempt was recorded failed and a retry of the same name reached ' +
        'ready with a new attempt id',
    },
    {
      type: 'runtime',
      value:
        'exact SHA ' + sha + ': two preparations over the same shared image set reused the warm ' +
        'cache (zero additional transfers) and received distinct Agent-owned workspaces; ' +
        'concurrent cache callers shared one fetch per digest',
    },
    {
      type: 'runtime',
      value:
        'exact SHA ' + sha + ': deleting one Session\'s managed context left another Session\'s ' +
        'context and shared image bytes untouched; a session refresh during preparation did ' +
        'not erase the in-flight context, while a stale preparing or a ready context for a ' +
        'removed Session was reclaimed',
    },
  );
  return 'Concurrent, retried and deleted Managed creations keep attempt, workspace and image ownership with truthful recoverable state';
});
