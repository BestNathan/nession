'use strict';
// #3023 SC-03: one cold fetch per Digest, digest verification before ready, and
// a warm hit with zero image-body transfers, including concurrent callers.
const { run, targetSha, assertRan } = require('../../../shared/control-mode-cases.cjs');
const { agentCacheTests } = require('../../../shared/erofs-cache-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const output = agentCacheTests('erofs_cache::tests::');
  assertRan(output, [
    'erofs_cache::tests::cold_fetch_publishes_the_verified_digest_and_warm_hit_transfers_nothing',
    'erofs_cache::tests::concurrent_callers_share_one_fetch_per_digest',
    'erofs_cache::tests::a_digest_mismatch_never_publishes_and_leaves_no_part',
  ]);
  evidence.push({
    type: 'runtime',
    value: 'exact SHA ' + sha + ': a cold authenticated fetch streamed once and published only after SHA-256 verification; two concurrent callers shared one fetch; the warm hit transferred zero body bytes; a mismatched body never became ready',
  });
  return 'Cold fetch downloads the exact authenticated blob once per Digest (including concurrent callers), validates SHA-256 before atomic ready state, and a warm cache hit performs zero image-body transfers';
});
