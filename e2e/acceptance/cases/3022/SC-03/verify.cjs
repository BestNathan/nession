'use strict';
// #3022 SC-03: repeated builds of the same pinned content and deterministic
// parameters produce one verified digest and reuse one physical image; a
// different revision never overwrites a referenced image.
const { run, targetSha, assertRan } = require('../../../shared/control-mode-cases.cjs');
const { mkfsVersion, runCargoTests, runIgnoredCargoTest } = require('../../../shared/erofs-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const mkfs = mkfsVersion();
  const real = runIgnoredCargoTest(
    'nession-erofs',
    'build::tests::real_erofs_build_is_deterministic',
  );
  assertRan(real, ['build::tests::real_erofs_build_is_deterministic']);
  const build = runCargoTests('nession-erofs', 'build::tests');
  assertRan(build, [
    'build::tests::repeated_local_builds_have_one_digest_and_reuse_one_blob',
    'build::tests::a_changed_source_revision_has_a_different_digest',
    'build::tests::the_mkfs_argv_is_fixed_and_deterministic',
  ]);
  const server = runCargoTests('nession-server', 'image::tests');
  assertRan(server, [
    'image::tests::identical_content_reuses_one_ready_image_and_one_blob',
    'image::tests::a_new_revision_changes_the_alias_without_overwriting_the_old_digest',
  ]);
  evidence.push({
    type: 'runtime',
    value: 'exact SHA ' + sha + ': ' + mkfs + '; identical source+packaging produced one digest and one sha256/<hex> blob; changed content produced a new digest while the old digest stayed readable; moving the alias did not overwrite it',
  });
  return 'Identical pinned content and packaging yield one verified immutable digest and one physical image; a different revision cannot silently overwrite a referenced image';
});
