'use strict';
// #3757 SC-01: credential-present preflight reaches the actual HTTP handshake,
// while missing/rejected auth never writes a Claude MCP entry.
const { run, targetSha, crateTests, assertRan, isolatedTmuxEnv } =
  require('../../../shared/mcp-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const out = crateTests(
    'nession-claude-code',
    ['--lib', 'mcp::connect::tests::'],
    110000,
    isolatedTmuxEnv('nession-3757-sc01-connect'),
  );
  assertRan(out, [
    'mcp::connect::tests::connect_blocks_without_a_verified_credential',
    'mcp::connect::tests::a_reachable_endpoint_and_accepted_credential_make_the_preflight_ready',
    'mcp::connect::tests::a_rejected_mcp_token_blocks_without_writing_claude_config',
    'mcp::connect::tests::a_confirmed_connect_writes_a_reference_and_reads_it_back',
  ]);
  evidence.push({
    type: 'runtime',
    value: 'staging ' + sha + ': isolated MCP HTTP initialize authenticates a bound-like credential, rejected/missing credentials block without config mutation, and success writes only a variable reference',
  });
  return 'Authenticated MCP preflight and secure Claude config write preserve fail-closed behavior';
});
