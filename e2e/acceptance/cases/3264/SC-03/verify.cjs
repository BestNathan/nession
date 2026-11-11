'use strict';
// #3264 SC-03: the typed argument fixture and the emitted input schema agree,
// invalid/unknown arguments are refused, the catalog is identical across the
// three hosts, and the registry is built once at startup.
const {
  run, targetSha, crateTests, assertRan, read, isolatedTmuxEnv,
} = require('../../../shared/mcp-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const env = isolatedTmuxEnv('nession-3264-sc03');

  const unit = crateTests('nession-mcp', ['--lib'], 600000, env);
  assertRan(unit, [
    'tool::tests::the_emitted_schema_and_the_typed_parser_agree',
    'tools::nession_server_list_agents::tests::its_schema_is_a_closed_empty_object',
    'tools::nession_agent_list_sessions::tests::agent_id_is_required_and_statically_typed',
    'tools::nession_agent_create_session::tests::its_schema_matches_the_typed_contract',
    'tools::nession_agent_kill_session::tests::its_schema_requires_both_identity_fields',
    'tools::nession_agent_create_session::tests::an_invalid_working_directory_type_is_refused',
    'tools::nession_agent_create_session::tests::an_unexpected_argument_is_refused',
    'tools::nession_agent_list_sessions::tests::an_unexpected_argument_is_refused',
    'tools::nession_server_list_agents::tests::an_unexpected_argument_is_refused',
  ]);

  const catalog = crateTests(
    'nession-mcp',
    ['--test', 'integration', 'standalone::all_three_hosts_share_one_tool_catalog'],
    900000,
    env,
  );
  assertRan(catalog, [
    'standalone::all_three_hosts_share_one_tool_catalog',
  ]);

  const invalid = crateTests(
    'nession-mcp',
    ['--test', 'integration', 'protocol::invalid_and_unknown_tool_calls_are_tool_errors_not_transport_errors'],
    900000,
    env,
  );
  assertRan(invalid, [
    'protocol::invalid_and_unknown_tool_calls_are_tool_errors_not_transport_errors',
  ]);

  const service = read('crates/nession-mcp/src/service.rs');
  const builds = service.split('tools::registry()').length - 1;
  if (builds !== 1) {
    throw new Error('the registry must be constructed exactly once at startup; found ' + builds);
  }

  evidence.push({
    type: 'runtime',
    value: 'exact SHA ' + sha + ': the schema is generated from the same typed contract that parses arguments; valid input is accepted and missing/typed-wrong/unexpected keys are refused',
  });
  evidence.push({
    type: 'runtime',
    value: 'Server-embedded, Agent-embedded and Standalone advertised byte-identical Tool definitions at ' + sha + ', and the registry is constructed once in McpService::new',
  });
  return 'typed argument contract, emitted schema and runtime validation agree; the catalog is identical across hosts and built once at startup';
});
