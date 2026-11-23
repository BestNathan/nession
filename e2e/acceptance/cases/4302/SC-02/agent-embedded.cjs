'use strict';
// #4302 SC-02: the Agent-embedded MCP host enforces the same contract end to
// end over real tmux — missing and empty expected identities are explicit
// `invalid_argument` refusals, a stale identity is a `conflict` that leaves the
// Session running, and the matching identity kills it.
const { run, targetSha, crateTests, assertRan, isolatedTmuxEnv } =
  require('../../../shared/mcp-cases.cjs');

const TEST = 'mcp::agent_mcp_kill_requires_and_enforces_the_observed_instance';

run(({ evidence }) => {
  const sha = targetSha();
  const out = crateTests(
    'nession-agent',
    ['--test', 'integration', TEST],
    110000,
    isolatedTmuxEnv('nession-4302-sc02-agent-embedded'),
  );
  assertRan(out, [TEST]);
  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ' over the Agent-embedded MCP host on real tmux: missing and empty ' +
      'expected_instance_id were refused as invalid_argument, a stale identity as conflict with ' +
      'the Session still listed under its own instance, and the matching identity killed it',
  });
  return 'The Agent-embedded MCP host enforces the observed-instance precondition with explicit refusals';
});
