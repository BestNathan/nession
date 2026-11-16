'use strict';
// #3735 SC-02: the Agent-embedded MCP host answers its own local Session state
// with the declared structured reply, and a refused argument carries none.
const { run, targetSha, crateTests, assertRan, isolatedTmuxEnv } =
  require('../../../shared/mcp-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const out = crateTests(
    'nession-agent',
    ['--test', 'integration', 'mcp::'],
    110000,
    isolatedTmuxEnv('nession-3735-sc02-agent'),
  );
  assertRan(out, ['mcp::agent_mcp_serves_local_tools_and_reports_a_missing_server']);
  evidence.push(
    {
      type: 'runtime',
      value:
        'nession-agent embedded MCP at exact SHA ' +
        sha +
        ' returned structuredContent equal to its text and no structured content for an error',
    },
  );
  return 'The Agent-embedded MCP host returns conformant structured success replies';
});
