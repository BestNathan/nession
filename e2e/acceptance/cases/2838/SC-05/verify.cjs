'use strict';
// #2838 SC-05: bounded provider reads and the consumer's stale-response guard.
// These are the real nession-git extension/runtime tests and the real Web
// selection integration test, not a mock asserting its own property.
const {
  run, targetSha, crateTests, assertRan, checked,
} = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();

  const unit = crateTests(
    'nession-git',
    ['--lib', 'runtime::preview::tests'],
    300000,
  );
  assertRan(unit, [
    'runtime::preview::tests::classifies_text_and_counts_exact_omitted_bytes',
    'runtime::preview::tests::classifies_a_nul_byte_as_binary_without_text',
    'runtime::preview::tests::a_nul_byte_late_in_the_file_is_still_binary',
    'runtime::preview::tests::truncates_at_the_byte_cap_and_reports_the_real_remainder',
    'runtime::preview::tests::a_multibyte_character_cut_by_the_cap_is_not_replaced_with_garbage',
    'runtime::preview::tests::invalid_utf8_is_not_shown_as_text',
    'runtime::preview::tests::refuses_a_final_symlink_instead_of_following_it',
    'runtime::preview::tests::refuses_a_symlinked_parent_instead_of_following_it',
    'runtime::preview::tests::a_fifo_cannot_block_the_open_and_is_not_a_regular_file',
    'runtime::preview::tests::a_permission_error_is_a_denied_answer_not_a_content_answer',
    'runtime::preview::tests::detects_a_path_replaced_after_the_handle_was_opened',
    'runtime::preview::tests::detects_a_repository_root_replaced_after_the_read_started',
  ]);

  // No name filter here: the symlink and binary proofs do not contain
  // "preview", and a filter would silently skip exactly the negative cases
  // this criterion names.
  const repository = crateTests(
    'nession-git',
    ['--test', 'repository'],
    300000,
  );
  assertRan(repository, [
    'an_untracked_text_file_has_a_bounded_preview',
    'a_conflicted_worktree_file_is_previewed_as_its_actual_bytes_once',
    'a_preview_refuses_a_path_that_is_not_the_selected_status_kind',
    'a_preview_refuses_a_missing_path_and_a_traversing_path',
    'an_untracked_symlink_is_unsupported_not_followed',
    'an_untracked_binary_file_is_classified_without_text',
  ]);

  const extension = crateTests(
    'nession-git',
    ['--test', 'extension', 'preview'],
    300000,
  );
  assertRan(extension, [
    'preview_returns_the_worktree_text_for_an_untracked_file',
    'preview_refuses_a_path_that_is_not_the_selected_status_kind',
  ]);

  const web = checked(
    'npm',
    [
      '--prefix', 'web', 'test', '--',
      '--project', 'integration',
      'src/capabilities/git/components/__tests__/integration/GitWorkspace.test.tsx',
      '-t', 'drops (a stale|an in-flight) preview',
    ],
    300000,
  );
  const cleanWeb = web.replace(/\x1b\[[0-9;]*m/g, '');
  if (!/\bTests\s+2 passed/.test(cleanWeb)) {
    throw new Error('the stale-preview consumer tests did not pass: ' + web.slice(-3000));
  }

  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': the real nession-git extension answered git.preview through the ' +
      'erased provider boundary; the runtime rejected a tracked/missing/traversing path and a ' +
      'symlink, mapped permission errors to a denied answer, returned the actual conflict bytes ' +
      'once, and bounded text with an exact omitted-byte count including a multi-byte cap boundary',
  });
  evidence.push({
    type: 'test',
    value:
      'the Web consumer tests selected two untracked files and kept the newer result when the older ' +
      'response arrived late, then switched Sessions while a preview was in flight and discarded it; ' +
      'Session→workdir resolution is the unchanged Agent-owned input to this boundary, covered by ' +
      'SC-04 source review rather than a live tmux Session',
  });
  return 'The real provider and consumer preserve bounded reads, typed change states and stale-response isolation';
});
