'use strict';
// #3082 SC-03: explicit Associate/Change/Remove validates access and Session
// ownership, handles revisions/missing Project/deletion, and never touches the
// running cwd, ENV binding, mounts or process.
const { run, targetSha, crateTests, assertRan } = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();

  const server = crateTests('nession-server', ['--lib', 'server_session_project_v1::'], 300_000);
  assertRan(server, [
    'association_is_authenticated_and_validates_entities',
    'association_is_revision_guarded_and_never_touches_runtime_state',
    'project_delete_unbinds_sessions_without_deleting_them',
  ]);

  const db = crateTests('nession-server', ['--lib', 'db::tests::'], 300_000);
  assertRan(db, ['project_delete_clears_bindings_but_preserves_sessions']);

  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': unauthenticated and malformed requests were refused with ' +
      'unauthorized/invalid; unknown Session/Project were not_found; a stale ' +
      'expected_revision was a conflict; Project deletion cleared the membership but kept ' +
      'the Session; association changed no cwd/ENV binding/Terminal state and destroyed ' +
      'nothing (server handler + DB tests)',
  });
  return 'Associate/Change/Remove is authorized, revision-guarded and deterministic, and never mutates the running Session or deletes it';
});
