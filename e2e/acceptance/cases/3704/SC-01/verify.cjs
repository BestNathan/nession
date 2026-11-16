'use strict';
// #3704 SC-01: real authenticated Agent MCP HTTP timeout while the shared
// Session lane is held, then authoritative tmux readback after FIFO release.
const {run, targetSha, crateTests, assertRan, isolatedTmuxEnv} = require('../../../shared/mcp-cases.cjs');

run(({evidence}) => {
  const sha = targetSha();
  const out = crateTests('nession-agent', [
    '--test', 'integration', 'mcp::agent_mcp_abandoned_queued_create_and_kill_preserve_tmux_state',
  ], 900000, isolatedTmuxEnv('nession-3704-sc01'));
  assertRan(out, ['mcp::agent_mcp_abandoned_queued_create_and_kill_preserve_tmux_state']);
  evidence.push({
    type: 'runtime',
    value: 'exact staging ' + sha + ': real Agent HTTP tools/call timed out behind the shared Session-key barrier; after FIFO release no abandoned create or kill changed the actual tmux Session list, and explicit readback/successful manual create+kill worked',
  });
  return 'Abandoned queued Agent MCP create and kill have no late Session side effect';
});
