'use strict';
// #3705 SC-02: token fail-closed projection + real Agent/Server MCP auth
// behind the existing host-owned listener. Credentials are test-only and
// never enter Case evidence.
const { run, targetSha, checked, crateTests, assertRan, isolatedTmuxEnv } =
  require('../../../shared/mcp-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const fixture = checked('node', ['scripts/mcp-image-config.test.mjs'], 30000);
  if (!fixture.includes('MCP_IMAGE_CONFIG_TEST PASS')) {
    throw new Error('image credential/default/rollback fixtures did not execute');
  }
  const env = isolatedTmuxEnv('nession-3705-sc02');
  const server = crateTests(
    'nession-server',
    ['--test', 'integration', 'mcp::embedded_mcp_authenticates_and_lists_the_shared_catalog'],
    900000, env,
  );
  assertRan(server, ['mcp::embedded_mcp_authenticates_and_lists_the_shared_catalog']);
  const agent = crateTests(
    'nession-agent',
    ['--test', 'integration', 'mcp::agent_mcp_refuses_an_anonymous_request'],
    900000, env,
  );
  assertRan(agent, ['mcp::agent_mcp_refuses_an_anonymous_request']);
  const protocol = crateTests(
    'nession-mcp',
    ['--test', 'integration', 'protocol::auth_and_path_fail_closed'],
    900000, env,
  );
  assertRan(protocol, ['protocol::auth_and_path_fail_closed']);
  evidence.push({
    type: 'runtime',
    value: 'staging ' + sha + ': image projection rejects missing Server token, bad NESSION_MCP_ENABLED and token-bearing logs; explicit disable works; Server/Agent embedded MCP listeners reject unauthenticated access and Server enumerates the shared catalog',
  });
  return 'Image MCP defaults preserve endpoint-owned tokens and fail closed';
});
