'use strict';
// #3181 SC-02: the Agent prepares every selected image into its owned cache and
// builds the canonical composition; the Server authorizes each grant.
const { run, crateTests, assertRan, targetSha } = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const agent = crateTests('nession-agent', ['sandbox_images::tests::', '--lib'], 600000);
  assertRan(agent, [
    'sandbox_images::tests::prepare_fetches_every_role_and_builds_the_composition',
    'sandbox_images::tests::preflight_builds_a_composition_from_metadata_without_fetching',
    'sandbox_images::tests::workspace_cleanup_refuses_an_unowned_path',
  ]);
  const server = crateTests(
    'nession-server',
    ['server::handler::tests::server_session_sandbox_v1::enter_authorizes_each_image_and_forwards_scoped_grants', '--lib'],
    600000,
  );
  assertRan(server, [
    'server::handler::tests::server_session_sandbox_v1::enter_authorizes_each_image_and_forwards_scoped_grants',
  ]);
  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': the Agent downloaded/verified each role into its identity cache and ' +
      'built the canonical Base/Workspace/toolchain composition; the Server minted one scoped grant ' +
      'per selected digest and the cleanup logic removed only its owned workspace',
  });
  return 'Project and Sandbox independently select images; Sandbox targets/modes become a verified Agent composition without owning image bytes';
});
