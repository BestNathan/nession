'use strict';
// #4302 SC-03: a timed-out MCP kill is abandoned, not silently retried. The
// kill is admitted to the keyed lane behind a blocker, the MCP request times
// out and reports `timeout`, and when the lane finally drains the abandoned
// call must not have started: the Session it named is still alive. A deliberate
// readback-then-retry then kills it with the observed instance.
const { run, targetSha, crateTests, assertRan, isolatedTmuxEnv } =
  require('../../../shared/mcp-cases.cjs');

const TEST = 'mcp::agent_mcp_abandoned_queued_create_and_kill_preserve_tmux_state';

run(({ evidence }) => {
  const sha = targetSha();
  const out = crateTests(
    'nession-agent',
    ['--test', 'integration', TEST],
    110000,
    isolatedTmuxEnv('nession-4302-sc03-abandoned'),
  );
  assertRan(out, [TEST]);
  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': an admitted-but-queued MCP kill whose HTTP request timed out ' +
      'reported kind timeout, never started when the lane drained, and left the named real tmux ' +
      'Session alive; only a deliberate readback-then-retry with the current instance killed it',
  });
  return 'A timed-out MCP kill does not silently retry against a replacement Session';
});
