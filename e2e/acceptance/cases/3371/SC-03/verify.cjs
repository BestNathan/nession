'use strict';
// #3371 SC-03: representative Server/Agent WebSocket (relay and P2P), MCP HTTP
// and typed AgentExtension request/reply paths accept the normalized snake_case
// wire keys, answer with matching keys, and refuse the retired camelCase
// spelling at a typed boundary that rejects unknown/missing fields.
const { run, targetSha, crateTests, assertRan } = require('../../../shared/mcp-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();

  const git = crateTests('nession-git', ['--test', 'extension'], 300_000);
  assertRan(git, [
    'a_reviewed_stage_is_applied_and_returns_the_new_state',
    'a_mutation_response_uses_the_contract_snake_case_keys',
    'the_retired_camel_case_request_spelling_is_refused',
  ]);

  const p2p = crateTests(
    'nession-agent',
    ['--test', 'integration', 'full_chain::test_client_connects_to_agent_via_p2p'],
    600_000,
  );
  assertRan(p2p, ['full_chain::test_client_connects_to_agent_via_p2p']);

  const mcp = crateTests('nession-mcp', ['--test', 'integration', 'protocol::'], 600_000);
  assertRan(mcp, [
    'protocol::modern_tool_calls_reach_the_semantic_backend',
    'protocol::a_retired_camel_case_tool_argument_is_refused_by_its_contract_name',
  ]);

  const relay = crateTests(
    'nession-server',
    [
      '--test',
      'integration',
      'websocket::a_relay_serves_the_servers_own_units_and_forwards_only_its_wires',
    ],
    600_000,
  );
  assertRan(relay, ['websocket::a_relay_serves_the_servers_own_units_and_forwards_only_its_wires']);

  evidence.push({
    type: 'protocol',
    value:
      'exact SHA ' + sha + ': a typed git stage request with expected_snapshot is applied and ' +
      'its response carries truncated_bytes; the retired expectedSnapshot spelling is refused ' +
      'with a decode error naming expected_snapshot and leaves the index unchanged',
  });
  evidence.push({
    type: 'protocol',
    value:
      'exact SHA ' + sha + ': P2P agent.session.list reply carries stale_agents (never ' +
      'staleAgents); the Server relay path and its post-relay reply use the same contract key',
  });
  evidence.push({
    type: 'protocol',
    value:
      'exact SHA ' + sha + ': MCP tools/call over real HTTP uses the snake_case Tool contract ' +
      'and refuses the retired agentId argument, naming agent_id',
  });
  return 'Server/Agent WebSocket relay and P2P, MCP HTTP and typed request/reply paths accept snake_case wire keys, answer with matching keys, and refuse the retired camelCase spelling';
});
