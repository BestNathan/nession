'use strict';
// #3399 SC-02: the Agent→Server seam must carry the replacement identity and
// the Server must adopt it. The watcher test asserts the outbox frame's
// `instance_id` field (the exact field the Server handler consumes); the
// registry test asserts an authoritative update replaces A with B and that a
// new incarnation does not inherit the previous Project membership.
const {
  run, targetSha, crateTests, assertRan,
} = require('../../../shared/control-mode-cases.cjs');

const AGENT =
  'sync::session_watcher::incarnation_replacement::' +
  'a_same_name_replacement_with_an_unchanged_shape_is_published';
const REGISTRY =
  'registry::session::tests::' +
  'an_authoritative_replacement_updates_the_registry_and_drops_the_old_project_binding';

run(({ evidence }) => {
  const sha = targetSha();

  const agent = crateTests('nession-agent', ['--lib', AGENT], 300_000);
  assertRan(agent, [AGENT]);

  const server = crateTests('nession-server', ['--lib', REGISTRY], 300_000);
  assertRan(server, [REGISTRY]);

  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': the watcher published the replacement on the ' +
      '"instance_id" payload field; the Server registry adopted instance-b for ' +
      '"agent:dev" and dropped the previous incarnation\'s Project membership ' +
      'instead of attributing it to the new Session',
  });
  return 'The replacement identity crosses the Agent→Server seam and the Server exposes B without inheriting the previous Project membership';
});
