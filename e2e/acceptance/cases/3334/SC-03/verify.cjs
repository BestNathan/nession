'use strict';
// #3334 SC-03: cancellation terminates owned subprocesses and retry reuses only
// validated completed stages; failures never publish bytes or move a Project
// reference/alias.
const { run, targetSha, assertRan } = require('../../../shared/control-mode-cases.cjs');
const { runCargoTests } = require('../../../shared/erofs-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const lifecycle = runCargoTests('nession-server', 'image::async_build_tests');
  assertRan(lifecycle, [
    'image::async_build_tests::cancellation_kills_the_owned_mkfs_process_and_publishes_nothing',
    'image::async_build_tests::retry_reuses_a_verified_snapshot_and_never_recopies_the_source',
    'image::async_build_tests::retry_refuses_a_local_source_without_a_validated_snapshot',
    'image::async_build_tests::a_stale_completion_does_not_overwrite_a_newer_alias_intent',
  ]);
  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': cancellation killed and reaped the owned mkfs subprocess, recorded ' +
      'canceled with no published bytes and no reference change; a packaging failure retained its ' +
      'verified snapshot, retry reran only packaging with the source deleted, preserved the failed ' +
      'attempt record, and a local source without a validated snapshot was refused rather than ' +
      'silently re-copied; a stale completion did not move a newer alias intent',
  });
  return 'Cancel/retry terminate owned work, preserve truthful attempts and never publish partial bytes or rebind a reference';
});
