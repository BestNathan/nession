'use strict';
// #3022 SC-01: canonical source validation plus a real EROFS build. A public
// GitHub HTTPS branch/full-SHA input resolves one exact commit; unsupported
// refs/URLs are refused; mkfs.erofs produces a real EROFS image; source SHA and
// packaging identity are recorded.
const { run, targetSha, assertRan } = require('../../../shared/control-mode-cases.cjs');
const { mkfsVersion, runCargoTests, runIgnoredCargoTest } = require('../../../shared/erofs-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const mkfs = mkfsVersion();
  const source = runCargoTests('nession-protocol', 'contracts::image::tests');
  assertRan(source, [
    'contracts::image::tests::public_github_https_repository_urls_normalize',
    'contracts::image::tests::private_ssh_http_and_ambiguous_repository_urls_are_refused',
    'contracts::image::tests::a_branch_or_full_commit_ref_is_normalized_and_ambiguous_refs_are_refused',
    'contracts::image::tests::local_directory_sources_must_be_absolute_without_parent_segments',
    'contracts::image::tests::aliases_and_digests_have_one_unambiguous_shape',
    'contracts::image::tests::packaging_identity_is_exactly_v1_deterministic',
  ]);
  const build = runIgnoredCargoTest(
    'nession-erofs',
    'build::tests::real_erofs_build_is_deterministic',
  );
  assertRan(build, ['build::tests::real_erofs_build_is_deterministic']);
  evidence.push({
    type: 'runtime',
    value: 'exact SHA ' + sha + ': ' + mkfs + '; canonical GitHub/branch/SHA/local validation passed; a real EROFS image (magic 0xE2E1F5E0) was built twice with the fixed packaging argv and one digest',
  });
  return 'Public GitHub branch/full-SHA and local-directory inputs validate deterministically, a real EROFS image is produced, and the pinned source SHA/packaging identity are recorded';
});
