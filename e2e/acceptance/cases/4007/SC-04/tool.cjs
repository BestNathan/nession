'use strict';
// #4007 SC-04: a confirmed-empty summary and a failed lookup stay distinct on
// the MCP projection, the summary never carries the description, and the
// Server Project projection (confirmed null vs unresolved) is unchanged.
const { run, targetSha, crateTests, assertRan, isolatedTmuxEnv } =
  require('../../../shared/mcp-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const out = crateTests(
    'nession-mcp',
    ['--lib', 'nession_agent_list_sessions'],
    110000,
    isolatedTmuxEnv('nession-4007-sc04-tool'),
  );
  assertRan(out, [
    'tools::nession_agent_list_sessions::tests::confirmed_empty_and_unavailable_summaries_stay_distinct',
    'tools::nession_agent_list_sessions::tests::a_summary_never_carries_the_description',
    'tools::nession_agent_list_sessions::tests::the_server_projection_keeps_identity_and_confirms_non_association',
    'tools::nession_agent_list_sessions::tests::server_metadata_enriches_unresolved_agent_sessions',
  ]);
  evidence.push({
    type: 'runtime',
    value:
      'nession-mcp at exact SHA ' +
      sha +
      ': a confirmed-empty summary serialized state=available revision 0 while ' +
      'a failed lookup serialized state=unavailable with no fabricated summary, ' +
      'the projection never contained description, and the Server projection ' +
      'still distinguished a confirmed non-association from unresolved metadata',
  });
  return 'Summary availability is explicit and the Project projection is unchanged';
});
