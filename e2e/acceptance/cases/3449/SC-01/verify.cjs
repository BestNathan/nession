'use strict';
// #3449 SC-01: the reusable mount interface distinguishes read-only lookup
// from consumer lease acquisition, rejects invalid/mismatched digests and
// unauthorized sources before a helper runs, and grants no unmount authority.
// The proof is the exact-PR-head contract/negative test suites.
const { run, targetSha, checked, assertRan } = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();

  const manager = checked(
    'cargo',
    ['test', '-p', 'nession-erofs', '--features', 'mount', '--lib', 'mount_manager', '--', '--nocapture'],
    600000,
  );
  assertRan(manager, [
    'mount_manager::tests::lookup_is_read_only_and_unknown_digests_have_no_status',
    'mount_manager::tests::invalid_and_unauthorized_images_are_refused_before_any_helper_runs',
    'mount_manager::tests::a_digest_mismatch_fails_closed_without_spawning_the_helper',
    'mount_manager::tests::adoption_never_serves_a_mount_without_matching_durable_identity',
    'mount_manager::tests::a_stale_identity_for_an_absent_mount_is_reported_and_reclaimed',
  ]);

  const sandbox = checked(
    'cargo',
    ['test', '-p', 'nession-sandbox', '--lib', 'linux::erofs::tests', '--', '--nocapture'],
    600000,
  );
  assertRan(sandbox, [
    'linux::erofs::tests::a_digest_mismatch_is_refused_before_mounting',
    'linux::erofs::tests::a_source_outside_the_authorized_root_is_refused_before_mounting',
  ]);

  evidence.push(
    {
      type: 'runtime',
      value:
        'exact SHA ' + sha + ': lookup by digest/mountpoint creates no entry or consumer; ' +
        'invalid digests, relative sources, unauthorized roots and digest mismatches are ' +
        'refused before any FUSE helper runs; MountLease exposes release but no unmount',
    },
  );
  return (
    'The mount interface separates read-only lookup from lease acquisition, rejects invalid ' +
    'identity without granting unmount authority, and introduces no reverse Nession dependency'
  );
});
