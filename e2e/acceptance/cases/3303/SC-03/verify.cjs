'use strict';
// #3303 SC-03: after the cache extraction, one cold authorized Range download
// and one warm hit keep the existing byte-transfer/verification semantics;
// interrupted downloads resume, corrupted downloads are rejected, per-identity
// namespaces stay isolated, concurrent callers share one fetch, and a pinned
// in-use blob cannot be evicted. The proof runs the real extracted cache API
// (`nession-erofs::cache`), and the Agent's production preparation path
// through the thin adapter.
const { run, targetSha, crateTests, assertRan } = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const cache = crateTests('nession-erofs', ['--features', 'cache', '--lib', 'cache::tests'], 600000);
  assertRan(cache, [
    'cache::tests::cold_fetch_publishes_the_verified_digest_and_warm_hit_transfers_nothing',
    'cache::tests::concurrent_callers_share_one_fetch_per_digest',
    'cache::tests::a_partial_download_resumes_with_one_range_request',
    'cache::tests::a_digest_mismatch_never_publishes_and_leaves_no_part',
    'cache::tests::a_corrupted_published_blob_is_rejected_and_refetched',
    'cache::tests::two_identities_on_one_volume_never_share_ready_or_partial_files',
    'cache::tests::eviction_refuses_a_pinned_digest_and_stale_partials_are_removed',
  ]);
  const agent = crateTests('nession-agent', ['--lib', 'managed_session::tests'], 600000);
  assertRan(agent, [
    'managed_session::tests::managed_prepare_downloads_pins_and_builds_the_composition',
  ]);
  evidence.push(
    {
      type: 'runtime',
      value:
        'exact SHA ' + sha + ': the extracted cache API performed one cold authenticated fetch ' +
        'and a warm hit with zero body transfers; an interrupted partial resumed with one Range ' +
        'request; a mismatched or corrupted body was rejected and never published; two identities ' +
        'on one root never shared ready or partial files; concurrent callers shared one fetch; ' +
        'a pinned digest was not evicted',
    },
    {
      type: 'runtime',
      value:
        'exact SHA ' + sha + ': the Agent Managed preparation used the extracted cache through ' +
        'its thin adapter, reusing the warm cache for a second attempt while creating a distinct ' +
        'Agent-owned workspace',
    },
  );
  return 'The extracted EROFS cache preserves cold/warm transfer, resume, verification, namespace isolation, concurrency and pin/eviction semantics through the real production adapter';
});
