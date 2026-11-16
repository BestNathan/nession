'use strict';
// #3735 SC-02: actual Server and Agent MCP calls return schema-valid
// `structuredContent` for every success path, the backwards-compatible text is
// the same reply, and error results are distinguishable and never structured.
//
// The tests are the same ones Quality runs; a Case is the merged-staging,
// source-aligned proof that the named evidence belongs to this exact SHA, not
// a second implementation of the behavior.
const { run, targetSha, crateTests, assertRan, isolatedTmuxEnv } =
  require('../../../shared/mcp-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();

  // The shared MCP service: all 11 Tools succeed with the advertised output,
  // a refused argument carries no structured success payload.
  const mcp = crateTests(
    'nession-mcp',
    ['--test', 'integration', 'structured_content'],
    900000,
    isolatedTmuxEnv('nession-3735-sc02-mcp'),
  );
  assertRan(mcp, [
    'protocol::every_successful_tool_call_returns_declared_structured_content',
    'protocol::a_refused_argument_result_carries_no_structured_content',
  ]);

  // The Server-embedded host answers through its real handler registry and
  // routes Agent-owned Tools to the explicitly named Agent.
  const server = crateTests(
    'nession-server',
    ['--test', 'integration', 'mcp::'],
    900000,
    isolatedTmuxEnv('nession-3735-sc02-server'),
  );
  assertRan(server, [
    'mcp::embedded_mcp_answers_server_owned_discovery_from_the_registry',
    'mcp::embedded_mcp_node_tools_route_to_the_named_agent',
  ]);

  // The Agent-embedded host answers its own local Session state.
  const agent = crateTests(
    'nession-agent',
    ['--test', 'integration', 'mcp::'],
    900000,
    isolatedTmuxEnv('nession-3735-sc02-agent'),
  );
  assertRan(agent, ['mcp::agent_mcp_serves_local_tools_and_reports_a_missing_server']);

  evidence.push(
    {
      type: 'runtime',
      value:
        'nession-mcp at exact SHA ' +
        sha +
        ' returned declared structuredContent for all 11 success paths and none for a refusal',
    },
    {
      type: 'runtime',
      value:
        'Server-embedded and Agent-embedded MCP calls returned the same structured reply as their text content',
    },
  );
  return 'Actual Nession MCP success paths return schema-valid structuredContent; error results remain distinct';
});
