'use strict';
// #3499 SC-04 (resolution): a Tag/Index resolves to one pinned platform
// Manifest with verified Config/EROFS descriptors; incompatible, ambiguous,
// stale and missing selections fail closed before a mount could be attempted.
const { run, targetSha, assertRan, crateTests } = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const resolution = crateTests('nession-erofs', ['image::resolve::tests'], 600_000);
  assertRan(resolution, [
    'image::resolve::tests::a_tag_resolves_to_the_platform_manifest_with_verified_descriptors',
    'image::resolve::tests::an_index_selects_only_the_compatible_platform_manifest',
    'image::resolve::tests::an_incompatible_platform_fails_before_any_mount_could_be_attempted',
    'image::resolve::tests::an_ambiguous_index_fails_closed',
    'image::resolve::tests::a_missing_tag_is_an_error_and_a_stale_descriptor_fails_closed',
    'image::resolve::tests::a_legacy_digest_resolves_through_the_migrated_manifest',
  ]);
  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': a Tag/Index resolved to one pinned platform Manifest ' +
      'with verified Config/EROFS descriptors; incompatible, ambiguous, stale and ' +
      'missing selections failed closed before a mount attempt',
  });
  return 'Tag/Index resolution pins one verified platform Manifest and fails closed before mount';
});
