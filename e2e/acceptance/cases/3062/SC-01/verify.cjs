'use strict';
// #3062 SC-01: Managed creation pins resolved source/image digests, prepares
// local cached EROFS, launches an authorized Sandbox initial Pane on a capable
// Linux Agent, and never silently falls back to Native when preparation or
// isolation fails.
//
// The proof is structural where the host boundary is owned by another
// component: the protocol shape, the Server's digest resolution/authorization
// and durable context, and the Agent's cache preparation + composition policy.
// The real mount/launch path is owned by #2681/#3024 and covered by their
// Cases; this Case asserts the Managed layer refuses rather than degrades.
const { run, targetSha, crateTests, assertRan } = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const protocol = crateTests('nession-protocol', ['--lib', 'contracts::session::tests'], 300000);
  assertRan(protocol, [
    'contracts::session::tests::a_client_managed_create_round_trips_its_pinned_artifacts',
    'contracts::session::tests::a_server_managed_create_carries_one_grant_per_role',
    'contracts::session::tests::unknown_managed_fields_are_refused',
  ]);
  const server = crateTests(
    'nession-server',
    ['--lib', 'server::handler::tests::server_session_managed_v1'],
    600000,
  );
  assertRan(server, [
    'server::handler::tests::server_session_managed_v1::managed_create_pins_and_authorizes_every_artifact',
    'server::handler::tests::server_session_managed_v1::a_managed_create_without_a_pinned_project_image_is_refused',
    'server::handler::tests::server_session_managed_v1::a_managed_create_with_a_non_ready_artifact_is_refused',
    'server::handler::tests::server_session_managed_v1::a_refused_managed_create_records_a_truthful_failed_context',
  ]);
  const agent = crateTests('nession-agent', ['--lib', 'managed_session::tests'], 600000);
  assertRan(agent, [
    'managed_session::tests::managed_prepare_downloads_pins_and_builds_the_composition',
    'managed_session::tests::a_missing_project_source_image_is_refused_before_any_workspace_exists',
    'managed_session::tests::a_digest_mismatch_fails_and_creates_no_workspace',
    'managed_session::tests::duplicate_base_images_are_refused',
    'managed_session::tests::toolchain_targets_stay_with_their_own_grant_when_digests_match',
  ]);
  evidence.push(
    {
      type: 'runtime',
      value:
        'exact SHA ' + sha + ': the managed create protocol carries the Base Runtime and Project ' +
        'Source digests plus one scoped grant per artifact; unknown fields are refused',
    },
    {
      type: 'runtime',
      value:
        'exact SHA ' + sha + ': the Server resolved ready artifacts, minted per-artifact grants, ' +
        'sent `/workspace` as the sandbox cwd and recorded a ready managed context with the ' +
        'resolved source commit; missing or non-ready artifacts were refused',
    },
    {
      type: 'runtime',
      value:
        'exact SHA ' + sha + ': the Agent downloaded and verified every image into its identity ' +
        'cache, built and compiled the `/` + `/workspace` + `/opt/rust` composition with an ' +
        'Agent-owned writable workspace; a missing image or digest mismatch failed closed with ' +
        'no workspace and no Native fallback',
    },
  );
  return 'Managed creation pins and authorizes every artifact, prepares the Agent cache and composition, and refuses missing or unverifiable artifacts instead of falling back to Native';
});
