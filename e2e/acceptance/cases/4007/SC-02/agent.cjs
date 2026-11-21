'use strict';
// #4007 SC-02: the Agent owner persists metadata across a store/Agent restart,
// answers a live legacy Session at revision 0, and a same-name recreation has
// its own identity and no inherited record.
const { run, targetSha, crateTests, assertRan, isolatedTmuxEnv } =
  require('../../../shared/mcp-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const out = crateTests(
    'nession-agent',
    ['--lib', 'session::metadata'],
    110000,
    isolatedTmuxEnv('nession-4007-sc02-agent'),
  );
  assertRan(out, [
    'session::metadata::tests::metadata_persists_across_a_store_restart',
    'session::metadata::tests::legacy_metadata_is_absent_until_the_first_save',
    'session::metadata::tests::a_recreated_session_of_the_same_name_does_not_inherit_metadata',
  ]);
  evidence.push({
    type: 'runtime',
    value:
      'nession-agent at exact SHA ' +
      sha +
      ': metadata survived a fresh store over the same tmux Session, a legacy ' +
      'Session read revision 0 with empty fields, and a recreated same-name ' +
      'Session started at revision 0 with a different instance identity',
  });
  return 'The Agent owner is durable across restart and never lends metadata to a successor';
});
