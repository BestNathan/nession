'use strict';
// #3407 SC-04 (Server half): the Project source image is added as the managed
// Workspace lower on both preflight and Enter.
const { run, targetSha, crateTests, assertRan } = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const server = crateTests('nession-server', [
    '--lib',
    'server::handler::tests::server_session_sandbox_v1::',
  ]);
  assertRan(server, [
    'server::handler::tests::server_session_sandbox_v1::preflight_managed_workspace_pins_the_project_source_image_as_lower',
    'server::handler::tests::server_session_sandbox_v1::enter_grants_the_project_source_image_for_a_managed_workspace',
  ]);
  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': preflight forwarded the Project source image as a workspace ' +
      '(overlay) selection and Enter minted its scoped grant with no target, so the Agent ' +
      'could prepare the pinned lower',
  });
  return 'Server-side managed Workspace lower admission and grant are proven';
});
