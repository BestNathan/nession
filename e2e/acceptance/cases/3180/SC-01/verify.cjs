'use strict';
// #3180 SC-01: two independent Agent identities on one durable storage root
// concurrently cold-fetch the same immutable digest. Their partial and ready
// files must be isolated, both must obtain checksum-valid bytes, and one
// identity's eviction must not touch the other's ready cache.
const { run, targetSha, assertRan } = require('../../../shared/control-mode-cases.cjs');
const { agentCacheTests } = require('../../../shared/erofs-cache-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const output = agentCacheTests('erofs_cache::tests::');
  assertRan(output, [
    'erofs_cache::tests::two_identities_on_one_volume_never_share_ready_or_partial_files',
    'erofs_cache::tests::an_identity_must_be_one_safe_path_segment',
    'erofs_cache::tests::concurrent_callers_share_one_fetch_per_digest',
  ]);
  evidence.push({
    type: 'runtime',
    value: 'exact SHA ' + sha + ': two Agent identities on one storage root ' +
      'concurrently cold-fetched one digest into separate namespaces; both ' +
      'published checksum-valid bytes, one eviction removed only its own blob, ' +
      'and an unsafe identity was refused before creating a namespace',
  });
  return 'Two independent Agent identities sharing one durable volume keep isolated mutable cache namespaces: concurrent cold fetches never corrupt each other and eviction cannot remove another Agent\'s ready bytes';
});
