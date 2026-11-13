'use strict';
// #3407 SC-01: one stable managed Workspace id per (namespace, name), durable
// across restart and listable with no live Session.
const { run, targetSha, crateTests, assertRan } = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const agent = crateTests('nession-agent', ['--lib', 'workspace_manager::tests::']);
  assertRan(agent, [
    'workspace_manager::tests::concurrent_get_or_create_returns_one_stable_id',
    'workspace_manager::tests::restart_reuses_the_same_id_and_bytes',
    'workspace_manager::tests::names_are_unique_per_namespace_not_globally',
    'workspace_manager::tests::name_normalization_is_the_uniqueness_alias',
  ]);
  const server = crateTests('nession-server', [
    '--lib',
    'server::handler::tests::server_workspace_v1',
  ]);
  assertRan(server, [
    'server::handler::tests::server_workspace_v1::workspace_list_relays_the_agent_inventory',
    'server::handler::tests::server_workspace_v1::workspace_create_relays_get_or_create',
    'server::handler::tests::server_workspace_v1::workspace_list_refuses_an_invalid_descriptor',
  ]);
  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': concurrent get-or-create returned one stable ws_ id; a reopened ' +
      'Agent registry returned the same id and durable bytes with no live Session; the same name ' +
      'in another namespace received a different id; the Session-scoped Server units relayed the ' +
      'Agent inventory and refused a descriptor that leaked a physical path',
  });
  return 'Stable managed Workspace identity, restart durability and the observed inventory are proven';
});
