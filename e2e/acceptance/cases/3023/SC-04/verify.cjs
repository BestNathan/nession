'use strict';
// #3023 SC-04: restart reuse, corruption rejection, and safe partial resume.
const { run, targetSha, assertRan } = require('../../../shared/control-mode-cases.cjs');
const { agentCacheTests } = require('../../../shared/erofs-cache-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const output = agentCacheTests('cache::tests::');
  assertRan(output, [
    'cache::tests::restart_reuses_a_verified_blob_without_another_transfer',
    'cache::tests::a_corrupted_published_blob_is_rejected_and_refetched',
    'cache::tests::a_partial_download_resumes_with_one_range_request',
    'cache::tests::a_digest_mismatch_never_publishes_and_leaves_no_part',
  ]);
  evidence.push({
    type: 'runtime',
    value: 'exact SHA ' + sha + ': a new cache instance over the same persistent directory reused the verified blob with zero transfers; a corrupted blob was rejected and refetched; a partial download resumed with one Range request and a mismatch never published',
  });
  return 'After restart with the same persistent directory the cache is rediscovered and reused; corrupted or partial downloads are never mounted and retry safely';
});
