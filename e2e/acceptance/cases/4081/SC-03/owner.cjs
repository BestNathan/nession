'use strict';
// #4081 SC-03: at the create owner, a duplicate-name refusal leaves the live
// Session's metadata untouched, a metadata-write failure removes the new
// Session and binding state (making the name retryable), and kill/recreate
// fences the committed record to the incarnation it was created for.
const { run, targetSha, crateTests, assertRan, isolatedTmuxEnv } =
  require('../../../shared/mcp-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const out = crateTests(
    'nession-agent',
    ['--lib', 'metadata'],
    300000,
    isolatedTmuxEnv('nession-4081-sc03-owner'),
  );
  assertRan(out, [
    'tmux::manager::metadata_create_tests::a_duplicate_name_refusal_leaves_the_existing_metadata_intact',
    'tmux::manager::metadata_create_tests::a_metadata_failure_removes_the_new_session_and_binding_state',
    'session::metadata::tests::initial_metadata_is_fenced_to_the_incarnation_it_was_created_with',
  ]);
  evidence.push({
    type: 'runtime',
    value:
      'nession-agent at exact SHA ' + sha + ': a duplicate-name create with new metadata ' +
      'was refused and the live record stayed byte-identical; a forced metadata-write ' +
      'failure removed the new tmux Session and binding state so the same name was ' +
      'immediately retryable; a same-name recreation received its own revision-1 record ' +
      'while the previous incarnation was retained',
  });
  return 'Creation failure and re-creation never succeed with missing or foreign metadata';
});
