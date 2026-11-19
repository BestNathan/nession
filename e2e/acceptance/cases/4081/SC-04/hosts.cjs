'use strict';
// #4081 SC-04: the same valid Create input carrying initial work context
// through Server-embedded, Agent-embedded, Server-routed standalone and
// direct-Agent standalone hosts persists the same normalized record on the
// explicitly targeted Agent; an unauthorized target is refused without
// falling back to the MCP host's Agent.
const { run, targetSha, crateTests, assertRan, isolatedTmuxEnv } =
  require('../../../shared/mcp-cases.cjs');

const TEST = 'standalone::session_metadata_creation_is_equivalent_across_hosts';

run(({ evidence }) => {
  const sha = targetSha();
  const out = crateTests(
    'nession-mcp',
    ['--test', 'integration', TEST],
    300000,
    isolatedTmuxEnv('nession-4081-sc04-hosts'),
  );
  assertRan(out, [TEST]);
  evidence.push({
    type: 'runtime',
    value:
      'nession-mcp at exact SHA ' + sha + ': one real Agent backed all four MCP ' +
      'hosting modes; each create with the same initial metadata persisted the same ' +
      'normalized revision-1 record on the targeted Agent, and a create naming a ' +
      'different Agent was refused with no Session created on the host Agent',
  });
  return 'Every hosting mode commits the same initial Session metadata on the explicit target';
});
