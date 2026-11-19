'use strict';
// #4007 SC-03: at the metadata owner, concurrent patches at one revision have
// exactly one winner, validation refusals leave the record unchanged, and the
// incarnation precondition refuses a successor before any write.
const { run, targetSha, crateTests, assertRan, isolatedTmuxEnv } =
  require('../../../shared/mcp-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const out = crateTests(
    'nession-agent',
    ['--lib', 'session::metadata'],
    110000,
    isolatedTmuxEnv('nession-4007-sc03-store'),
  );
  assertRan(out, [
    'session::metadata::tests::a_patch_preserves_omitted_fields_and_clears_explicit_nulls',
    'session::metadata::tests::guarded_writes_refuse_a_successor_instance_and_leave_it_intact',
    'session::metadata::tests::stale_revision_is_refused_and_prior_metadata_is_intact',
    'session::metadata::tests::invalid_values_are_refused_without_writing',
    'session::metadata::tests::an_empty_patch_is_refused_without_writing',
    'session::metadata::tests::concurrent_patches_at_one_revision_have_one_winner',
  ]);
  evidence.push({
    type: 'runtime',
    value:
      'nession-agent at exact SHA ' +
      sha +
      ': eight concurrent patches at one revision produced one commit at ' +
      'revision 2; omitted fields were preserved, explicit null and [] cleared ' +
      'only their fields, invalid/empty patches wrote nothing, and a stale ' +
      'instance was a conflict with the successor record intact',
  });
  return 'The Agent owner is the single atomic patch authority with revision and incarnation fences';
});
