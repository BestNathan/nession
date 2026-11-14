'use strict';
// #3334 SC-02: a completed snapshot survives a terminated owner; the restarted
// Server reruns packaging from the validated snapshot, discards partial output,
// and publishes a real mkfs.erofs image with the pinned source identity.
const { run, targetSha, assertRan } = require('../../../shared/control-mode-cases.cjs');
const {
  mkfsVersion,
  runCargoTests,
  runIgnoredCargoTest,
} = require('../../../shared/erofs-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const mkfs = mkfsVersion();
  const units = runCargoTests('nession-server', 'image::async_build_tests');
  assertRan(units, [
    'image::async_build_tests::restart_recovery_resumes_from_the_verified_snapshot',
    'image::async_build_tests::retry_reuses_a_verified_snapshot_and_never_recopies_the_source',
    'image::async_build_tests::corrupted_durable_state_is_rejected_not_resumed',
  ]);
  const real = runIgnoredCargoTest(
    'nession-server',
    'image_build_restart::a_restarted_server_reruns_packaging_from_the_validated_snapshot',
  );
  assertRan(real, [
    'image_build_restart::a_restarted_server_reruns_packaging_from_the_validated_snapshot',
  ]);
  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': ' + mkfs + '; an interrupted packaging attempt left a partial .part, ' +
      'the durable snapshot checkpoint survived the owner stopping, a second manager re-acquired ' +
      'the build root, reran packaging (never trusting the partial), published one verified blob ' +
      'with EROFS magic 0xE2E1F5E0, and completed without the deleted local source; corrupted state ' +
      'directories were rejected instead of resumed',
  });
  return 'Stage-level restart recovery reruns only packaging from a verified snapshot and publishes only verified immutable bytes';
});
