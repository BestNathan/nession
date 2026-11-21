'use strict';
// #4007 SC-04: the list summary is bounded (title/tags/revision, no
// description), is the same Agent answer from every hosting mode, and a
// Session with no saved metadata is a confirmed revision 0. The Project
// projection keeps its existing semantics.
const { run, targetSha, crateTests, assertRan, isolatedTmuxEnv } =
  require('../../../shared/mcp-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const out = crateTests(
    'nession-mcp',
    ['--test', 'integration', 'session_metadata_tools_share_owner_truth_across_hosts'],
    110000,
    isolatedTmuxEnv('nession-4007-sc04-hosts'),
  );
  assertRan(out, [
    'standalone::session_metadata_tools_share_owner_truth_across_hosts',
  ]);
  evidence.push({
    type: 'runtime',
    value:
      'nession-mcp at exact SHA ' +
      sha +
      ': all four hosting modes listed the saved Session with the same ' +
      'title/tags/revision summary and no description, listed a no-metadata ' +
      'Session as available revision 0, and kept the Project projection intact',
  });
  return 'Session lists expose bounded, mode-independent work-context summaries';
});
