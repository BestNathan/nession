'use strict';
// #565 SC-07: with no Server, Agent-local tools still work and cluster tools
// return a structured unreachable/absent-backend error.
const { run, targetSha, crateTests, assertRan, isolatedTmuxEnv } = require('../../../shared/mcp-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const out = crateTests(
    'nession-agent',
    ['--test', 'integration', 'mcp::agent_mcp_serves_local_tools_and_reports_a_missing_server'],
    900000,
    isolatedTmuxEnv('nession-565-sc07'),
  );
  assertRan(out, ['mcp::agent_mcp_serves_local_tools_and_reports_a_missing_server']);
  evidence.push(
    { type: 'runtime', value: 'Agent-local create/list/kill passed against real tmux with no Server configured at ' + sha },
    { type: 'runtime', value: 'nession_server_* returned isError with an explicit standalone/no-Server message' },
  );
  return 'Agent-local tools work while the Server is absent, and cluster tools report the missing backend instead of pretending';
});
