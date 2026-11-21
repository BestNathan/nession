'use strict';
// #3778 SC-03: one contributed Tool is advertised by its owning Agent and
// invoked through Server-embedded and Standalone MCP hosts. Wrong Agent,
// unknown Session, offline owner and conflicting/stale manifests fail closed
// without cross-Agent fallback; direct Agent execution serves the same Tool.
const {
  run, targetSha, crateTests, assertRan, isolatedTmuxEnv,
} = require('../../../shared/mcp-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const env = isolatedTmuxEnv('nession-3778-sc03');

  // Server-embedded and Standalone clients, one fixture contribution, with the
  // offline/wrong-target/unknown-Session/conflicting/stale negative paths.
  const routing = crateTests(
    'nession-mcp',
    ['--test', 'integration', 'standalone::extension_tool_routes_to_the_named_agent_across_hosts'],
    900000,
    env,
  );
  assertRan(routing, [
    'standalone::extension_tool_routes_to_the_named_agent_across_hosts',
  ]);

  // Agent-embedded/direct execution of the same contribution on the P2P
  // surface, including foreign-Agent and unadvertised-Tool refusal.
  const agent = crateTests(
    'nession-agent',
    ['--test', 'integration', 'mcp::agent_p2p_mcp_tool_call_executes_its_own_contribution'],
    900000,
    env,
  );
  assertRan(agent, [
    'mcp::agent_p2p_mcp_tool_call_executes_its_own_contribution',
  ]);

  // The Server's manifest validator keeps the last valid generation when a
  // candidate is incompatible or stale.
  const validator = crateTests(
    'nession-server',
    ['--lib', 'extension_tools::'],
    600000,
    env,
  );
  assertRan(validator, [
    'server::extension_tools::tests::two_agents_cannot_advertise_one_name_with_different_contracts',
    'server::extension_tools::tests::an_unsupported_manifest_version_is_refused_without_changing_the_catalog',
    'server::extension_tools::tests::a_call_for_an_agent_without_a_manifest_fails_closed',
    'server::extension_tools::tests::identical_same_name_tools_from_two_agents_merge_into_one_definition',
  ]);

  evidence.push({
    type: 'runtime',
    value: 'exact SHA ' + sha + ': a fixture Extension Tool advertised by one Agent was listed and invoked through Server-embedded and Standalone MCP hosts against the explicitly named owning Agent, and the Server brokered exactly one call to that Agent',
  });
  evidence.push({
    type: 'runtime',
    value: 'exact SHA ' + sha + ': a wrong Agent, an unknown owner-specific Session, an offline owner, a conflicting same-name contract and an unsupported manifest version each failed closed (not_found/unavailable) with no cross-Agent fallback; the capability stayed listed while its owner was offline',
  });
  evidence.push({
    type: 'runtime',
    value: 'exact SHA ' + sha + ': the owning Agent executed the same contributed Tool on its direct P2P surface and refused a foreign agent_id and an unadvertised Tool',
  });

  return 'One fixture contribution was discoverable and executable by the named owner across Server, Standalone and Agent surfaces; incompatible and stale manifests were refused while the last valid generation stayed live.';
});
