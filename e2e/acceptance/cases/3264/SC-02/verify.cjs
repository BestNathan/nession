'use strict';
// #3264 SC-02: one Tool, one same-named flat module, one explicit registration.
// The registry refuses duplicates and unknown calls; there is no central
// match-name dispatch and no nested tools/server or tools/agent directories.
const fs = require('node:fs');
const path = require('node:path');
const {
  run, targetSha, crateTests, assertRan, read,
} = require('../../../shared/mcp-cases.cjs');

const root = path.resolve(__dirname, '../../../../..');
const tools = path.join(root, 'crates/nession-mcp/src/tools');
const names = [
  'nession_server_list_agents',
  'nession_agent_list_sessions',
  'nession_agent_create_session',
  'nession_agent_kill_session',
];

run(({ evidence }) => {
  const sha = targetSha();

  const unit = crateTests('nession-mcp', ['--lib'], 600000);
  assertRan(unit, [
    'tools::tests::the_registry_advertises_exactly_the_four_baseline_tools',
    'registry::tests::duplicate_registration_is_rejected',
    'registry::tests::an_unknown_tool_is_an_argument_error',
    'tools::nession_server_list_agents::tests::an_unexpected_argument_is_refused',
    'tools::nession_agent_list_sessions::tests::a_missing_target_is_refused',
    'tools::nession_agent_create_session::tests::an_empty_name_is_refused',
    'tools::nession_agent_kill_session::tests::a_missing_name_is_refused',
  ]);

  const entries = fs.readdirSync(tools).sort();
  const expected = ['mod.rs', ...names.map((name) => name + '.rs')].sort();
  if (JSON.stringify(entries) !== JSON.stringify(expected)) {
    throw new Error('tools/ must be flat and one file per Tool; found ' + entries.join(','));
  }
  if (fs.existsSync(path.join(tools, 'server')) || fs.existsSync(path.join(tools, 'agent'))) {
    throw new Error('tools/ must not contain nested server/ or agent/ directories');
  }

  for (const name of names) {
    const source = read('crates/nession-mcp/src/tools/' + name + '.rs');
    if (!/impl ToolHandler for/.test(source)) {
      throw new Error(name + '.rs does not implement ToolHandler');
    }
    if (!source.includes('"' + name + '"')) {
      throw new Error(name + '.rs does not declare its exact MCP Tool name');
    }
    if (!source.includes('schema_for::<')) {
      throw new Error(name + '.rs does not generate its schema from the typed contract');
    }
  }

  const modules = read('crates/nession-mcp/src/tools/mod.rs');
  if (!modules.includes('ToolRegistry::build(')) {
    throw new Error('tools/mod.rs does not register handlers with one ToolRegistry');
  }
  if (/match\s+name(\.as_str\(\))?\s*\{/.test(modules)) {
    throw new Error('tools/mod.rs contains a central match-name dispatch');
  }
  if (/(macro_rules!|inventory::|linkme::)/.test(modules)) {
    throw new Error('tools/mod.rs uses automatic/macro registration');
  }
  const registry = read('crates/nession-mcp/src/registry.rs');
  if (!registry.includes('RegistryError::Duplicate')) {
    throw new Error('the registry does not reject duplicate Tool names');
  }
  const service = read('crates/nession-mcp/src/service.rs');
  if (!service.includes('self.registry.call(')) {
    throw new Error('the service does not dispatch through the registry');
  }
  if (!service.includes('tools::registry()')) {
    throw new Error('the service does not build the catalog at startup');
  }

  evidence.push({
    type: 'runtime',
    value: 'exact SHA ' + sha + ': cargo unit tests prove four same-named ToolHandlers, duplicate-name rejection, unknown-Tool rejection and per-Tool argument refusal',
  });
  evidence.push({
    type: 'runtime',
    value: 'tools/ is flat with exactly mod.rs plus the four <tool_name>.rs modules; registration is explicit through one ToolRegistry and the service dispatches through it, with no match-name dispatcher',
  });
  return 'each Tool has one flat same-named module and one explicit registration; duplicates, unknown calls and invalid arguments are rejected';
});
