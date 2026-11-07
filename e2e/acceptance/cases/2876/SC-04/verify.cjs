'use strict';
// #2876 SC-04: the real nession-git provider enforces the same authorization
// for media as for text — path/status validation, no symlink following, a
// bounded complete answer, and identity rechecks — and the Web consumer drops a
// stale selection while revoking the previous Blob URL.
const {
  run, targetSha, crateTests, assertRan, checked,
} = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();

  const repository = crateTests(
    'nession-git',
    ['--test', 'repository'],
    300000,
  );
  assertRan(repository, [
    'an_untracked_png_returns_complete_media_bytes_and_mime',
    'media_refuses_a_file_larger_than_the_bound',
    'media_refuses_content_that_does_not_match_the_extension',
    'media_refuses_a_non_media_path_even_with_media_bytes',
    'media_refuses_a_path_that_is_not_the_selected_status_kind',
    'media_does_not_follow_an_untracked_symlink',
    'a_preview_refuses_a_missing_path_and_a_traversing_path',
    'an_untracked_symlink_is_unsupported_not_followed',
  ]);

  const extension = crateTests(
    'nession-git',
    ['--test', 'extension', 'preview'],
    300000,
  );
  assertRan(extension, [
    'preview_returns_complete_media_bytes_for_an_untracked_image',
    'a_text_preview_does_not_carry_media_fields',
  ]);

  const runtime = crateTests(
    'nession-git',
    ['--lib', 'runtime::preview::tests'],
    300000,
  );
  assertRan(runtime, [
    'refuses_a_final_symlink_instead_of_following_it',
    'refuses_a_symlinked_parent_instead_of_following_it',
    'detects_a_path_replaced_after_the_handle_was_opened',
    'detects_a_repository_root_replaced_after_the_read_started',
  ]);

  const web = checked(
    'npm',
    [
      '--prefix', 'web', 'test', '--',
      '--project', 'integration',
      'src/capabilities/git/__tests__/integration/useGitSelection.media.test.tsx',
    ],
    300000,
  );
  const cleanWeb = web.replace(/\x1b\[[0-9;]*m/g, '');
  if (!/\bTests\s+2 passed/.test(cleanWeb)) {
    throw new Error('the media selection tests did not pass: ' + web.slice(-3000));
  }

  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': the real nession-git provider returned complete bounded media for an ' +
      'untracked image, refused oversized/mismatched/non-media/tracked/traversing/symlinked paths, ' +
      'kept text answers free of media fields, and rechecked the opened file/root/status identity ' +
      'before returning bytes',
  });
  evidence.push({
    type: 'test',
    value:
      'the Web selection hook asked for media bytes only for a media path, revoked the previous Blob ' +
      'URL on the next selection, and dropped a late media answer instead of displaying or retaining it',
  });
  return 'Git media reads preserve the #2838 authorization/TOCTOU boundary and the consumer cannot retain stale media';
});
