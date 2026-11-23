'use strict';
// #4081 SC-02: at the Agent owner, a create with initial title/description/tags
// commits a normalized revision 1 for that incarnation, a fresh metadata store
// over the same tmux Session reads it back (store/Agent restart), and an omitted
// metadata object still produces the confirmed revision-0 record.
const { run, targetSha, crateTests, assertRan, isolatedTmuxEnv } =
  require('../../../shared/mcp-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const committed = crateTests(
    'nession-agent',
    ['--lib', 'initial_metadata_is'],
    300000,
    isolatedTmuxEnv('nession-4081-sc02-owner'),
  );
  assertRan(committed, [
    'session::metadata::tests::initial_metadata_is_committed_as_revision_one_for_the_new_incarnation',
    'session::metadata::tests::initial_metadata_is_fenced_to_the_incarnation_it_was_created_with',
  ]);
  const empty = crateTests(
    'nession-agent',
    ['--lib', 'create_without_initial_metadata_still_starts_at_revision_zero'],
    300000,
    isolatedTmuxEnv('nession-4081-sc02-empty'),
  );
  assertRan(empty, [
    'tmux::manager::metadata_create_tests::create_without_initial_metadata_still_starts_at_revision_zero',
  ]);
  evidence.push({
    type: 'runtime',
    value:
      'nession-agent at exact SHA ' + sha + ': a create with title/description/tags ' +
      'committed normalized revision 1 for its own tmux incarnation; a fresh metadata ' +
      'store over the same Session read the same record; a create without metadata ' +
      'produced the confirmed revision-0 record',
  });
  return 'Create-time initial metadata is committed, durable across restart and defaults to revision 0';
});
