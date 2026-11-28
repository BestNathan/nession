'use strict';
// #4665 SC-01: `input_sent` + `observation: verified` is returned only after the
// prompt's submission is confirmed by read-back; unconfirmed delivery answers a
// truthful unknown with read-back guidance.
//
// This verifier pins the delivery classification in the exact-PR-head Rust
// fixtures; `verify-live.cjs` runs the startup-race and large-prompt injections
// against a real pinned Claude CLI. The Case is selected only by the `live-cli`
// lane (result_policy all-pass), so fixtures alone cannot Pass.
const {
  run, crateTests, assertRan, isolatedTmuxEnv,
} = require('../../../shared/mcp-cases.cjs');

run(({ evidence }) => {
  const composer = crateTests(
    'nession-claude-code',
    ['--lib', 'composer::'],
    600000,
    isolatedTmuxEnv('nession-4665-sc01-composer'),
  );
  assertRan(composer, [
    'composer::tests::an_empty_composer_is_ready',
    'composer::tests::a_dimmed_try_hint_is_an_empty_composer',
    'composer::tests::a_focused_hint_with_an_inverted_cursor_character_is_an_empty_composer',
    'composer::tests::a_purely_reverse_video_run_is_not_a_hint',
    'composer::tests::a_rule_shaped_empty_composer_is_ready',
    'composer::tests::a_rule_shaped_composer_with_typed_text_is_dirty',
    'composer::tests::typed_text_after_the_prompt_is_dirty',
    'composer::tests::an_unsent_paste_placeholder_is_dirty_even_though_styled',
    'composer::tests::an_overflow_indicator_is_dirty',
    'composer::tests::a_startup_screen_without_an_input_box_is_not_recognized',
  ]);
  const delivery = crateTests(
    'nession-agent',
    ['--lib', 'claude_control::submit_delivery_tests::'],
    600000,
    isolatedTmuxEnv('nession-4665-sc01-delivery'),
  );
  assertRan(delivery, [
    'claude_control::submit_delivery_tests::a_confirmed_submission_is_input_sent_and_verified',
    'claude_control::submit_delivery_tests::an_unconfirmed_submission_is_unknown_not_verified',
    'claude_control::submit_delivery_tests::an_unready_tui_is_refused_without_sending',
  ]);
  evidence.push({
    type: 'runtime',
    value: 'the composer observation classifies empty/dirty/unready input boxes fail-closed, and the real submit path answers input_sent+verified only for a newly recorded exact user message, unknown with read-back guidance when the TUI never submitted, and refused before sending when the input box is not ready',
  });
  return 'the verified-delivery read-back contract is pinned in source; the live verifier injects the startup race and the large single-line prompt against a real Claude CLI';
});
