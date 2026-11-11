'use strict';
// #3082 SC-02: membership is incarnation-scoped and survives Agent refresh,
// re-registration, restart and reconnect; a reused agent_id:session_name never
// inherits the previous Project.
const { run, targetSha, crateTests, assertRan } = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();

  const db = crateTests('nession-server', ['--lib', 'db::tests::'], 300_000);
  assertRan(db, [
    'session_project_binding_round_trips_across_restart',
    'pending_binding_adopts_the_first_report_and_invalidates_a_reused_name',
    'force_refresh_reconciliation_drops_removed_sessions_only',
    'explicit_agent_deletion_clears_memberships',
    'session_delete_clears_its_binding',
  ]);

  const handler = crateTests('nession-server', ['--lib', 'server_session_project_v1::'], 300_000);
  assertRan(handler, [
    'reconnect_cache_clear_preserves_membership',
    'a_reused_session_name_does_not_inherit_membership',
  ]);

  const protocol = crateTests('nession-protocol', ['contracts::session::tests::'], 300_000);
  assertRan(protocol, ['test_session_instance_identity_is_optional_on_updates_and_reports']);

  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': reopening the database restored the same membership; a ' +
      'reconnect-style cache clear preserved it; a force-refresh absence removed only the ' +
      'gone Session; explicit Agent deletion removed the Agent memberships; a new tmux ' +
      'instance with the same agent_id:session_name did not inherit the previous Project ' +
      '(durable @nession_instance_id, tmux created_at fallback; DB + handler + protocol tests)',
  });
  return 'Membership survives report/refresh/reconnect/restart and is invalidated on destruction; a reused Session name never inherits the previous Project';
});
