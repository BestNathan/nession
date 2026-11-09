'use strict';
// #3021 SC-02: zero, one or multiple Existing Agent+directory locations and an
// optional Git source/defaults are all valid; an offline or unknown Agent and
// an absent source never prevent persistence.
const {
  run, targetSha, crateTests, assertRan,
} = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();

  const protocol = crateTests(
    'nession-protocol',
    ['contracts::project::tests::'],
    300_000,
  );
  assertRan(protocol, [
    'a_create_payload_with_only_a_name_deserializes',
    'multiple_locations_on_offline_agents_are_accepted',
    'source_locations_defaults_and_digest_round_trip',
  ]);

  const server = crateTests(
    'nession-server',
    ['--lib', 'server_project_create_v1'],
    300_000,
  );
  assertRan(server, [
    'project_create_with_name_only_persists',
    'project_create_accepts_source_locations_defaults_and_digest',
  ]);

  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': a Project with no Agent/location/source persisted; a Project ' +
      'declaring an offline Agent, a second location, a Git source, Session defaults and a ' +
      'digest persisted and read back unchanged; the location validation never queried an ' +
      'Agent (protocol + server handler tests)',
  });
  return 'Zero/one/multiple Existing Locations and optional source/defaults persist regardless of Agent availability or an absent Git source';
});
