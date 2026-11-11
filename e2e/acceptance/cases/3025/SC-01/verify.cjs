'use strict';
// #3025 SC-01: an Existing Location creates a normal Session through the
// selected Agent and directory; the Project reference is optional on the wire;
// legacy clients and no-Project creates are unchanged; a missing or offline
// Agent is an explicit refusal that preserves the Project declaration.
const {
  run, targetSha, crateTests, assertRan,
} = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();

  const protocol = crateTests(
    'nession-protocol',
    ['contracts::session::tests::'],
    300_000,
  );
  assertRan(protocol, [
    'test_client_session_create_project_reference_is_optional_and_round_trips',
  ]);

  const server = crateTests(
    'nession-server',
    ['--lib', 'server_session_create_v1::'],
    300_000,
  );
  assertRan(server, [
    'project_session_create_uses_the_declared_existing_location',
    'legacy_session_create_without_a_project_is_unchanged',
    'project_session_create_requires_a_directory',
    'project_session_create_rejects_an_unknown_project',
    'project_session_create_rejects_a_directory_outside_the_project',
    'project_session_create_reports_an_offline_agent_without_creating',
    'session_create_agent_not_found',
  ]);

  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': a Project-associated create sent the declared Agent/directory ' +
      'as the Agent initial cwd and never leaked the Project into the Agent payload; the wire ' +
      'contract kept project_id optional for old clients; a no-Project create stayed unchanged; ' +
      'missing, offline, absent-directory and non-declared Agent/directory states were refused ' +
      'explicitly, and an offline refusal preserved the Project declaration (protocol + server ' +
      'handler tests)',
  });
  return 'An Existing Location creates a normal Session on its declared Agent/directory, legacy and no-Project creates are unchanged, and missing/offline Agent states are explicit refusals';
});
