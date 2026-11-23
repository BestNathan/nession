'use strict';
// #4007 SC-03: a description-only patch preserves title/tags, explicit nulls
// and empty tags clear only their fields, a stale revision refuses, and a
// stale incarnation cannot mutate a recreated same-name Session even at
// revision 0. Proven through the real Agent P2P route.
const { run, targetSha, crateTests, assertRan, isolatedTmuxEnv } =
  require('../../../shared/mcp-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const out = crateTests(
    'nession-agent',
    [
      '--test',
      'integration',
      'integration_session_metadata_patch_fences_revision_and_incarnation',
    ],
    110000,
    isolatedTmuxEnv('nession-4007-sc03-route'),
  );
  assertRan(out, [
    'server::integration_session_metadata_patch_fences_revision_and_incarnation',
  ]);
  evidence.push({
    type: 'runtime',
    value:
      'nession-agent at exact SHA ' +
      sha +
      ': a description-only patch preserved title/tags; title+tags replaced ' +
      'without clearing the description; a stale revision and an empty patch ' +
      'were refused; after kill/recreate the old instance token was a conflict ' +
      'and only the successor identity committed',
  });
  return 'Partial updates commit atomically under revision and incarnation preconditions';
});
