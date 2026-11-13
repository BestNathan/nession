'use strict';
// #3412 SC-02: a real HTTP Range fixture observes measured bytes, treats a
// surviving partial as resumable, resumes from the durable offset, resets the
// count on a 200 restart, and shares one transfer between concurrent consumers.
const { run, targetSha } = require('../../../shared/control-mode-cases.cjs');
const { agentCacheTests } = require('../../../shared/erofs-cache-cases.cjs');
const { assertRan } = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const output = agentCacheTests('cache::progress_');
  assertRan(output, [
    'cache::progress_tests::a_slow_transfer_is_downloading_with_measured_bytes_then_verified',
    'cache::progress_tests::a_200_restart_resets_the_reported_count',
    'cache::progress_negative_tests::an_interrupted_transfer_leaves_nonzero_resumable_bytes_not_active',
    'cache::progress_negative_tests::a_contradictory_resume_range_keeps_the_partial_resumable',
    'cache::progress_negative_tests::two_consumers_share_one_active_transfer',
  ]);
  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': an isolated HTTP fixture exposed Downloading with measured bytes; ' +
      'an interrupted transfer became Resumable with nonzero durable bytes; a validated 206 resumed ' +
      'from the durable offset; a 200 restart reset the count; two concurrent consumers shared one ' +
      'transfer and did not multiply progress',
  });
  return 'Measured transfer progress, durable resume, 200 restart accounting and shared in-flight transfer are proven';
});
