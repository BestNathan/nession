'use strict';
// #3794 SC-02: a created Managed Session persists its immutable resolved image
// and workspace snapshot. Later Project edits change only what a new Session
// would receive; a refused prepare records failure and never falls back to
// Native or disturbs another Session's managed context.
const { run, targetSha, crateTests, assertRan } = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const server = crateTests('nession-server', [
    '--lib',
    'server::handler::tests::server_session_managed_v1',
  ]);
  assertRan(server, [
    'server::handler::tests::server_session_managed_v1::a_created_managed_session_keeps_its_pinned_snapshot_after_project_edits',
    'server::handler::tests::server_session_managed_v1::a_refused_managed_create_records_a_truthful_failed_context',
    'server::handler::tests::server_session_managed_v1::deleting_one_managed_context_keeps_another_sessions',
    'server::handler::tests::server_session_managed_v1::a_changed_project_git_source_refuses_a_stale_pinned_image',
  ]);
  const agent = crateTests('nession-agent', ['--lib', 'managed_session::tests::']);
  assertRan(agent, [
    'managed_session::tests::managed_prepare_downloads_pins_and_builds_the_composition',
  ]);
  evidence.push(
    {
      type: 'runtime',
      value:
        'exact SHA ' + sha + ': a created Managed Session kept its base, Project Source digest, ' +
        'resolved image bindings and workspace after the Project image/source were edited',
    },
    {
      type: 'runtime',
      value:
        'a refused Agent prepare recorded a truthful failed managed context with no created ' +
        'Session and no Native fallback',
    },
    {
      type: 'runtime',
      value:
        'deleting one Session managed context left another Session context intact; the Agent ' +
        'prepared the composition from the pinned grants and its durable cache',
    },
  );
  return 'The created Session owns its pinned image/workspace snapshot; failures stay Managed and bounded';
});
