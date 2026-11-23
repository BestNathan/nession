'use strict';
// #3796 SC-01: an authorized prepare/resume of an absent or partial Manifest
// fetches the required closure exactly once, aggregates measured observations,
// and a corrupt or interrupted attempt never reports mount-ready.
const { run, targetSha, crateTests, assertRan } = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const prepare = crateTests(
    'nession-agent',
    ['--lib', 'erofs_cache::prepare_tests::'],
    600_000,
  );
  assertRan(prepare, [
    'erofs_cache::prepare_tests::prepare_fetches_an_absent_manifest_closure_exactly_once',
    'erofs_cache::prepare_tests::concurrent_prepares_share_one_closure_transfer',
    'erofs_cache::prepare_tests::retry_refetches_a_corrupt_versioned_layer',
    'erofs_cache::prepare_tests::a_manifest_observation_aggregates_its_required_layer',
    'erofs_cache::prepare_tests::prepare_requires_the_matching_explicit_intent',
  ]);
  const resume = crateTests(
    'nession-erofs',
    ['--features', 'cache', '--lib', 'cache::progress_'],
    600_000,
  );
  assertRan(resume, [
    'cache::progress_negative_tests::an_interrupted_transfer_leaves_nonzero_resumable_bytes_not_active',
    'cache::progress_negative_tests::two_consumers_share_one_active_transfer',
  ]);
  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': an explicit prepare fetched the Manifest, Config and EROFS layer ' +
      'exactly once and reported Verified; concurrent prepares shared one transfer; a corrupt ' +
      'layer was Failed and Retry refetched it; a Manifest whose layer was absent was not ' +
      'reported mount-ready and its aggregate became Verified only after the layer verified; ' +
      'an interrupted transfer stayed Resumable with measured bytes',
  });
  return 'authorized prepare resolves the whole Manifest closure exactly once and never calls an unverified closure mount-ready';
});
