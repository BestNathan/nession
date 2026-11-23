'use strict';
// #4007 SC-02: Get reports the same Agent-owned metadata and authoritative
// instance identity from Server-embedded, Agent-embedded, Server-routed
// standalone and explicit direct-Agent standalone hosts. A legacy Session is
// revision 0; a missing Session is an error, never an empty record.
const { run, targetSha, crateTests, assertRan, isolatedTmuxEnv } =
  require('../../../shared/mcp-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const out = crateTests(
    'nession-mcp',
    ['--test', 'integration', 'session_metadata_tools_share_owner_truth_across_hosts'],
    110000,
    isolatedTmuxEnv('nession-4007-sc02-hosts'),
  );
  assertRan(out, [
    'standalone::session_metadata_tools_share_owner_truth_across_hosts',
  ]);
  evidence.push({
    type: 'runtime',
    value:
      'nession-mcp at exact SHA ' +
      sha +
      ': one real Agent backed all four MCP hosting modes; Get returned the same ' +
      'revision-0 record and instance identity from each, a missing Session was ' +
      'not_found rather than an empty success, and the list carried the summary',
  });
  return 'Every hosting mode reads one owner-backed Session metadata record and identity';
});
