'use strict';
// #3910 SC-03: `nession_agent_list_sessions` returns the Server's current
// authoritative project_id for Project-created and subsequently Web-associated
// Sessions; a confirmed non-association is explicit null, while unresolved
// metadata is omitted rather than guessed. The other Agent Session fields
// remain and no session_type/Project object is invented.
const {
  run, targetSha, crateTests, assertRan, isolatedTmuxEnv,
} = require('../../../shared/mcp-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const env = isolatedTmuxEnv('nession-3910-sc03');

  const unit = crateTests(
    'nession-mcp',
    ['--lib', 'tools::nession_agent_list_sessions::tests::'],
    600_000,
    env,
  );
  assertRan(unit, [
    'the_server_projection_keeps_identity_and_confirms_non_association',
    'an_agent_projection_derives_identity_and_leaves_project_unresolved',
    'server_metadata_enriches_unresolved_agent_sessions',
    'an_unavailable_server_leaves_metadata_omitted_instead_of_guessing',
  ]);

  const runtime = crateTests(
    'nession-mcp',
    [
      '--test',
      'integration',
      'standalone::project_context_sessions_use_server_association_and_real_agent_runtime',
    ],
    900_000,
    env,
  );
  assertRan(runtime, [
    'standalone::project_context_sessions_use_server_association_and_real_agent_runtime',
  ]);

  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': the real Server+Agent+tmux Case listed a Project-created Session with project_id set, a never-associated Session as explicit null, and after Web reassociation reported the current association; the Agent Session identity and runtime fields remained',
  });
  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': direct-Agent output omits unresolved project metadata, an unreachable Server omits it instead of null, and the output contract carries session_id plus only optional project_id',
  });
  return 'Agent Session listing projects the Server current association with truthful null vs omitted semantics and no second Session type';
});
