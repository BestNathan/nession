'use strict';
// #3779 SC-05 (2/4): the Agent's own shared catalog advertises all six Tools
// with their typed schemas, the three read Tools execute the existing Units
// against the same real Session truth the endpoint serves, and the direct P2P
// surface executes only its own contribution.
const {
  run, targetSha, crateTests, assertRan, isolatedTmuxEnv,
} = require('../../../shared/mcp-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const env = isolatedTmuxEnv('nession-3779-sc05-agent');
  const agent = crateTests(
    'nession-agent',
    ['--test', 'integration',
      'mcp::agent_mcp_exposes_the_claude_conversation_and_transcript_readers'],
    900000,
    env,
  );
  assertRan(agent, [
    'mcp::agent_mcp_exposes_the_claude_conversation_and_transcript_readers',
  ]);
  const p2p = crateTests(
    'nession-agent',
    ['--test', 'integration',
      'mcp::agent_p2p_mcp_tool_call_executes_its_own_contribution'],
    900000,
    env,
  );
  assertRan(p2p, [
    'mcp::agent_p2p_mcp_tool_call_executes_its_own_contribution',
  ]);
  evidence.push({
    type: 'runtime',
    value: 'exact SHA ' + sha + ': the Agent catalog advertised all six Tools and the three read Tools executed the existing conversation/transcript Units against a real Session (empty ready list, exact-id not_found, no substituted conversation, no transcript path)',
  });
  evidence.push({
    type: 'runtime',
    value: 'exact SHA ' + sha + ': the direct P2P surface executed its own contribution and refused a foreign Agent and an unadvertised Tool',
  });
  return 'the Agent catalog and direct P2P surface serve exactly the contributed Claude Tools';
});
