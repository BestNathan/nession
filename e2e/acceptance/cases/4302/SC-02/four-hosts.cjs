'use strict';
// #4302 SC-02: every hosting route preserves the guarded kill contract —
// Server-embedded MCP, Agent-embedded MCP, Server-routed standalone and direct
// Agent standalone. A stale instance is a classified `conflict` on all four
// routes and never terminates the current Session; a caller that reads the
// current instance then kills it successfully.
const { run, targetSha, crateTests, assertRan, isolatedTmuxEnv } =
  require('../../../shared/mcp-cases.cjs');

const TEST = 'session_metadata_tools_share_owner_truth_across_hosts';

run(({ evidence }) => {
  const sha = targetSha();
  const out = crateTests(
    'nession-mcp',
    ['--test', 'integration', TEST],
    110000,
    isolatedTmuxEnv('nession-4302-sc02-four-hosts'),
  );
  assertRan(out, [TEST]);
  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': on the same real Agent, the server-embedded, agent-embedded, ' +
      'server-routed standalone and direct-Agent standalone hosts each answered a stale-instance ' +
      'kill as conflict; the current Session stayed listed; reading its instance and killing ' +
      'with that identity succeeded',
  });
  return 'All four MCP hosting routes refuse a stale incarnation identically and preserve a matching kill';
});
