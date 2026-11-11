'use strict';
// #3303 SC-05: existing Server->Agent Managed Session creation still resolves
// scoped grants to verified cached images and a usable isolated working root,
// including failure/cleanup and restart/reuse behavior. The proof reuses the
// #3062 source-aligned Server/Agent tests at the merged staging SHA; no
// registry, Project identity or Session orchestration moved into nession-erofs.
const { run, targetSha, crateTests, assertRan } = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const server = crateTests(
    'nession-server',
    ['--lib', 'server::handler::tests::server_session_managed_v1'],
    600000,
  );
  assertRan(server, [
    'server::handler::tests::server_session_managed_v1::managed_create_pins_and_authorizes_every_artifact',
    'server::handler::tests::server_session_managed_v1::a_failed_managed_create_is_retryable',
    'server::handler::tests::server_session_managed_v1::a_ready_managed_session_is_not_recreated_by_a_same_named_attempt',
    'server::handler::tests::server_session_managed_v1::deleting_one_managed_context_keeps_another_sessions',
  ]);
  const agent = crateTests('nession-agent', ['--lib', 'managed_session::tests'], 600000);
  assertRan(agent, [
    'managed_session::tests::managed_prepare_downloads_pins_and_builds_the_composition',
    'managed_session::tests::a_digest_mismatch_fails_and_creates_no_workspace',
    'managed_session::tests::a_missing_project_source_image_is_refused_before_any_workspace_exists',
  ]);
  const cache = crateTests(
    'nession-erofs',
    ['--features', 'cache', '--lib', 'cache::tests::restart_'],
    600000,
  );
  assertRan(cache, [
    'cache::tests::restart_reuses_a_verified_blob_without_another_transfer',
  ]);
  evidence.push(
    {
      type: 'runtime',
      value:
        'exact SHA ' + sha + ': the Server still resolved ready artifacts, minted per-artifact ' +
        'grants, refused missing/non-ready artifacts, fenced concurrent attempts and kept ' +
        'deletion isolated to the removed Session',
    },
    {
      type: 'runtime',
      value:
        'exact SHA ' + sha + ': the Agent still downloaded through the extracted cache adapter, ' +
        'built and compiled the isolated composition with an Agent-owned writable workspace, ' +
        'reused the warm cache on restart and failed closed on a missing image or digest ' +
        'mismatch without a Native fallback',
    },
  );
  return 'Managed Session creation still resolves scoped grants to verified cached images and a usable isolated working root after the EROFS extraction, with unchanged failure, cleanup and restart behavior';
});
