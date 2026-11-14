'use strict';
// #3499 SC-04: at the exact merged staging SHA, scoped image grants resolve a
// Tag/Index to a pinned Manifest, two authorized consumers of one EROFS layer
// share one physical cache file and one physical mount, an Agent restart
// re-verifies instead of re-downloading, and removing a consumer releases its
// Manifest pin. These are executable crate/Server/Agent tests in the target
// checkout; the Case does not claim a live deployment.
const { run, targetSha, assertRan, crateTests } = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();

  const resolution = crateTests('nession-erofs', ['image::resolve::tests'], 600_000);
  assertRan(resolution, [
    'image::resolve::tests::a_tag_resolves_to_the_platform_manifest_with_verified_descriptors',
    'image::resolve::tests::an_index_selects_only_the_compatible_platform_manifest',
    'image::resolve::tests::an_incompatible_platform_fails_before_any_mount_could_be_attempted',
    'image::resolve::tests::an_ambiguous_index_fails_closed',
    'image::resolve::tests::a_missing_tag_is_an_error_and_a_stale_descriptor_fails_closed',
    'image::resolve::tests::a_legacy_digest_resolves_through_the_migrated_manifest',
  ]);

  const transfer = crateTests('nession-erofs', ['--features', 'cache', 'distribution::'], 600_000);
  assertRan(transfer, [
    'distribution::transfer::tests::concurrent_requests_for_one_digest_share_one_transfer',
    'distribution::transfer::tests::an_interrupted_transfer_keeps_a_resumable_partial_and_never_publishes',
    'distribution::transfer::tests::a_digest_mismatch_removes_the_partial_and_never_publishes',
    'distribution::transfer::tests::a_stale_descriptor_size_fails_closed_even_when_the_digest_matches',
    'distribution::transfer::tests::a_restart_adopts_only_bytes_that_still_hash_to_the_digest',
  ]);

  const fetch = crateTests('nession-erofs', ['--features', 'cache', 'cache::fetch::tests'], 600_000);
  assertRan(fetch, [
    'cache::fetch::tests::two_manifests_share_one_payload_download_and_one_physical_file',
    'cache::fetch::tests::a_descriptor_mismatch_fails_before_the_payload_is_fetched',
    'cache::fetch::tests::unverified_payload_bytes_never_produce_a_layer_path',
    'cache::fetch::tests::an_agent_restart_adopts_only_reverifiable_metadata_and_payload',
  ]);

  const eviction = crateTests('nession-erofs', ['--features', 'cache', 'cache::eviction::tests'], 600_000);
  assertRan(eviction, [
    'cache::eviction::tests::a_pinned_payload_is_protected_while_unpinned_metadata_is_reclaimable',
    'cache::eviction::tests::eviction_scans_only_this_identity_and_serializes_an_invalid_digest',
  ]);

  const cacheRestart = crateTests(
    'nession-erofs',
    [
      '--features',
      'cache',
      'cache::tests::restart_reuses_a_verified_blob_without_another_transfer',
    ],
    600_000,
  );
  assertRan(cacheRestart, [
    'cache::tests::restart_reuses_a_verified_blob_without_another_transfer',
  ]);

  const cacheIdentity = crateTests(
    'nession-erofs',
    [
      '--features',
      'cache',
      'cache::tests::two_identities_on_one_volume_never_share_ready_or_partial_files',
    ],
    600_000,
  );
  assertRan(cacheIdentity, [
    'cache::tests::two_identities_on_one_volume_never_share_ready_or_partial_files',
  ]);

  // The physical mount is keyed on the EROFS layer digest: two configs of one
  // layer acquire the same mount and release independently.
  const mount = crateTests(
    'nession-erofs',
    ['--features', 'mount', 'mount_manager::tests::two_consumers_of_one_layer_share_one_physical_mount'],
    600_000,
  );
  assertRan(mount, [
    'mount_manager::tests::two_consumers_of_one_layer_share_one_physical_mount',
  ]);

  const server = crateTests(
    'nession-server',
    ['image::tests::manifest_resolution_shares_one_layer_but_not_authorization'],
    600_000,
  );
  assertRan(server, [
    'image::tests::manifest_resolution_shares_one_layer_but_not_authorization',
  ]);

  const binding = crateTests(
    'nession-server',
    ['image::tests::a_session_binding_records_and_releases_the_resolved_manifest_pin'],
    600_000,
  );
  assertRan(binding, [
    'image::tests::a_session_binding_records_and_releases_the_resolved_manifest_pin',
  ]);

  const served = crateTests(
    'nession-server',
    ['image::tests::catalog_metadata_is_served_only_after_digest_and_size_verification'],
    600_000,
  );
  assertRan(served, [
    'image::tests::catalog_metadata_is_served_only_after_digest_and_size_verification',
  ]);

  const handler = crateTests(
    'nession-server',
    ['a_manifest_create_mints_reachable_object_grants_and_records_the_binding'],
    600_000,
  );
  assertRan(handler, [
    'a_manifest_create_mints_reachable_object_grants_and_records_the_binding',
  ]);

  const agent = crateTests(
    'nession-agent',
    ['managed_session::tests::a_manifest_grant_mounts_the_layer_identity_and_shares_one_payload'],
    600_000,
  );
  assertRan(agent, [
    'managed_session::tests::a_manifest_grant_mounts_the_layer_identity_and_shares_one_payload',
  ]);

  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': crate/Server/Agent tests proved Tag/Index resolution to one ' +
      'pinned platform Manifest with verified Config/EROFS descriptors, incompatible and ' +
      'ambiguous selections failing before a mount, scoped Manifest grants with independent ' +
      'authorization across two consumers sharing one EROFS layer, exactly one payload ' +
      'download and one physical cache file, one physical mount shared by two consumers, ' +
      'Range-resumed interrupted/latest transfers and Agent restarts yielding only verified ' +
      'Ready files, pins preventing eviction, and Session cleanup releasing the resolved ' +
      'Manifest pin',
  });
  return (
    'At the exact staging SHA, two authorized Manifest consumers share one verified EROFS ' +
    'payload and one physical mount, resolution fails closed on incompatible/ambiguous/' +
    'stale images, interrupted and restarted transfers publish only verified bytes, and ' +
    'Session cleanup releases its Manifest pin'
  );
});
