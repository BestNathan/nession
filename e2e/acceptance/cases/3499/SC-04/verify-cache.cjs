'use strict';
// #3499 SC-04 (cache): shared payload download/cache identity, resume/restart
// verification, and pin-guarded eviction for one Agent identity.
const { run, targetSha, assertRan, crateTests } = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();

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

  const eviction = crateTests(
    'nession-erofs',
    ['--features', 'cache', 'cache::eviction::tests'],
    600_000,
  );
  assertRan(eviction, [
    'cache::eviction::tests::a_pinned_payload_is_protected_while_unpinned_metadata_is_reclaimable',
    'cache::eviction::tests::eviction_scans_only_this_identity_and_serializes_an_invalid_digest',
  ]);

  const cacheRestart = crateTests(
    'nession-erofs',
    ['--features', 'cache', 'cache::tests::restart_reuses_a_verified_blob_without_another_transfer'],
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

  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': an interrupted Range transfer kept a resumable partial and ' +
      'never published, a restart adopted only re-hashed bytes, two Manifests shared one ' +
      'payload download and one physical cache file, pins blocked eviction, and two identities ' +
      'on one volume never shared Ready or partial files',
  });
  return 'Shared, resumed and restarted transfers yield one verified payload while pins protect it';
});
