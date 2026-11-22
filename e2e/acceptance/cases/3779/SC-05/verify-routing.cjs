'use strict';
// #3779 SC-05 (3/4): the general contribution contract these Tools ride carries
// a contributed Tool to the explicitly named owner on Server-embedded and
// Standalone hosts; a wrong Agent, offline owner, unknown owner-specific
// Session or incompatible/stale manifest fails closed with no cross-Agent
// fallback.
const {
  run, targetSha, crateTests, assertRan, isolatedTmuxEnv,
} = require('../../../shared/mcp-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const routing = crateTests(
    'nession-mcp',
    ['--test', 'integration',
      'standalone::extension_tool_routes_to_the_named_agent_across_hosts'],
    900000,
    isolatedTmuxEnv('nession-3779-sc05-routing'),
  );
  assertRan(routing, [
    'standalone::extension_tool_routes_to_the_named_agent_across_hosts',
  ]);
  evidence.push({
    type: 'runtime',
    value: 'exact SHA ' + sha + ': the contributed-Tool routing contract carried the Tools to the named owner on Server-embedded and Standalone hosts, and wrong Agent/offline owner/unknown owner-specific Session failed closed with no fallback',
  });
  return 'contributed Tools route only to their named owner across Server-embedded and Standalone hosts';
});
