'use strict';
// #3697 SC-03: the real Linux toolchain builds a referenced metadata image
// from two source blobs, and after every source payload is deleted the Agent
// cache transfers the closure and erofsfuse mounts the complete tree.
const { run, targetSha, checked, assertRan } = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  checked('sudo', ['apt-get', 'update', '-qq'], 120_000);
  checked(
    'sudo',
    ['apt-get', 'install', '-y', '-qq', 'erofs-utils', 'erofsfuse', 'fuse3', 'fuse-overlayfs'],
    600_000,
  );
  const build = checked(
    'cargo',
    [
      'test',
      '-p',
      'nession-erofs',
      'build::referenced::tests::real_referenced_composite_reuses_source_bytes_deterministically',
      '--',
      '--ignored',
      '--nocapture',
    ],
    900_000,
  );
  assertRan(build, [
    'build::referenced::tests::real_referenced_composite_reuses_source_bytes_deterministically',
  ]);
  const mount = checked(
    'cargo',
    [
      'test',
      '-p',
      'nession-erofs',
      '--features',
      'cache,mount',
      '--test',
      'referenced_composite_mount',
      '--',
      '--ignored',
      '--nocapture',
    ],
    900_000,
  );
  assertRan(mount, [
    'a_referenced_composite_transfers_and_mounts_after_sources_are_deleted',
  ]);
  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': two real mkfs.erofs sources became one metadata ' +
      'image referencing both blobs with deterministic metadata/descriptor digests ' +
      'and a fail-closed inline-data diagnostic; after deleting every source ' +
      'payload, the Agent cache fetched the Manifest/Config/Composite/metadata/' +
      'device closure and erofsfuse mounted and read files from both devices',
  });
  return 'a trusted Linux host mounts and reads the complete referenced Composite after the source blobs are removed';
});
