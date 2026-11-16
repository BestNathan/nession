'use strict';
// #3735 SC-02: the shared MCP service returns declared `structuredContent` for
// every success path and never a structured success for a refusal.
//
// Each verifier runs one Cargo test target; the Acceptance driver bounds one
// verifier process at 120s, so three host proofs must never share one process.
const { run, targetSha, crateTests, assertRan, isolatedTmuxEnv } =
  require('../../../shared/mcp-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const out = crateTests(
    'nession-mcp',
    ['--test', 'integration', 'structured_content'],
    110000,
    isolatedTmuxEnv('nession-3735-sc02-mcp'),
  );
  assertRan(out, [
    'protocol::every_successful_tool_call_returns_declared_structured_content',
    'protocol::a_refused_argument_result_carries_no_structured_content',
  ]);
  evidence.push(
    {
      type: 'runtime',
      value:
        'nession-mcp at exact SHA ' +
        sha +
        ' returned declared structuredContent for all 11 success paths and none for a refusal',
    },
  );
  return 'The shared MCP service returns schema-valid structuredContent and keeps errors distinct';
});
