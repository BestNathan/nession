'use strict';
// #4234 SC-02: the Server Session read model exposes the membership revision
// tied to the current Session incarnation. The membership CAS rejects a stale
// token and reports the current one, an optional incarnation precondition
// fences a same-name replacement, and the legacy optional-revision path is
// unchanged.
const {
  run,
  targetSha,
  crateTests,
  assertRan,
} = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();

  const handler = crateTests(
    'nession-server',
    ['--lib', 'server_session_project_v1::'],
    300_000,
  );
  assertRan(handler, [
    // server.session.list advertises project_revision 0 for an unassociated
    // or removed Session, the committed revision otherwise.
    'association_round_trips_and_projects_through_session_list',
    // A stale observed token is a conflict that reports the current token,
    // including across remove/reassociate (ABA).
    'stale_revision_after_remove_and_reassociate_is_a_conflict',
    // A same-name replacement cannot be written with a revision from the
    // previous incarnation, even when the numeric token collides.
    'expected_instance_id_fences_a_same_name_replacement',
    // The documented optional-revision (last-writer-wins) compatibility and
    // the atomic concurrent CAS semantics remain intact.
    'concurrent_associations_with_the_same_expected_revision_commit_once',
    'concurrent_first_associations_commit_once',
    'concurrent_association_and_removal_never_lose_the_committed_state',
  ]);

  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': server.session.list exposed project_revision 0 for ' +
      'an unassociated/removed Session and the committed revision otherwise; a stale ' +
      'expected_revision was refused as a conflict reporting the current token, including ' +
      'after remove/reassociate; a same-name replacement rejected a write carrying the ' +
      'previous incarnation even when the numeric revision collided; concurrent sets ' +
      'committed once and the optional-revision compatibility still succeeded ' +
      '(server handler tests over isolated SQLite)',
  });
  return 'The Session read model exposes the incarnation-scoped membership token; stale revisions and stale incarnations conflict with the current token reported';
});
