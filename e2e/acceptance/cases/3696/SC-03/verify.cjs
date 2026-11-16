'use strict';
// #3696 SC-03: a flattened Compose build runs through the existing durable
// build lifecycle, publishes one authorized result, and an Agent cache can
// transfer and mount that result after every source Image is gone.
const {
  run,
  targetSha,
  checked,
  assertRan,
  crateTests,
} = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();

  // Real toolchain: mkfs.erofs → fsck.erofs staging → merged mkfs.erofs,
  // deterministic digest and EROFS superblock magic.
  const compose = checked(
    'cargo',
    [
      'test',
      '-p',
      'nession-erofs',
      'build::compose::tests::real_erofs_compose_is_deterministic_and_mountable_metadata',
      '--',
      '--ignored',
      '--nocapture',
    ],
    900_000,
  );
  assertRan(compose, [
    'build::compose::tests::real_erofs_compose_is_deterministic_and_mountable_metadata',
  ]);

  // Lifecycle: the Compose build resumes from a verified snapshot, and the
  // shared async build lifecycle keeps cancel/retry/restart behavior.
  const resume = crateTests(
    'nession-erofs',
    ['build::compose::tests::a_verified_snapshot_resumes_packaging_without_sources'],
    600_000,
  );
  assertRan(resume, [
    'build::compose::tests::a_verified_snapshot_resumes_packaging_without_sources',
  ]);
  const lifecycle = crateTests(
    'nession-server',
    [
      'image::async_build_tests::',
    ],
    600_000,
  );
  assertRan(lifecycle, [
    'image::async_build_tests::cancellation_kills_the_owned_mkfs_process_and_publishes_nothing',
    'image::async_build_tests::retry_reuses_a_verified_snapshot_and_never_recopies_the_source',
    'image::async_build_tests::restart_recovery_resumes_from_the_verified_snapshot',
  ]);

  // Transfer + mount: only the result Manifest/Config/layer are served; every
  // source payload is deleted first. The Agent cache verifies the result and
  // erofsfuse reads the complete composed tree.
  const mount = checked(
    'cargo',
    [
      'test',
      '-p',
      'nession-erofs',
      '--features',
      'cache,mount',
      '--test',
      'compose_agent_mount',
      '--',
      '--ignored',
      '--nocapture',
    ],
    900_000,
  );
  assertRan(mount, [
    'a_compose_result_transfers_to_the_agent_cache_and_mounts_without_sources',
  ]);

  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': two real mkfs.erofs sources composed through ' +
      'fsck.erofs staging into one deterministic flattened layer; a verified ' +
      'compose snapshot resumed packaging; the shared async build lifecycle ' +
      'cancel/retry/restart tests passed; after deleting every source payload, ' +
      'the Server-authorized Manifest/Config/layer transferred into the Agent ' +
      'cache and erofsfuse mounted the complete tree with source-independent reads',
  });
  return 'a Compose build survives the durable cancel/retry/restart lifecycle, publishes one authorized result, and the Agent cache mounts it after every source is gone';
});
