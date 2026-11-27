'use strict';
// #4665 SC-02: a submit targeting a Claude whose composer holds unsubmitted
// text never silently appends — it is refused or safely reconciled — and a
// replay after a lost-Enter event cannot produce an unchecked second
// submission.
//
// This verifier pins the dirty-composer refusal and the replay classification
// in the exact-PR-head Rust fixtures; `verify-live.cjs` pre-fills a real
// Claude composer and proves the refusal, the absence of concatenation, and
// the safe reconcile. The Case is selected only by the `live-cli` lane
// (result_policy all-pass), so fixtures alone cannot Pass.
const {
  run, crateTests, assertRan, isolatedTmuxEnv,
} = require('../../../shared/mcp-cases.cjs');

run(({ evidence }) => {
  const delivery = crateTests(
    'nession-agent',
    ['--lib', 'claude_control::submit_delivery_tests::'],
    600000,
    isolatedTmuxEnv('nession-4665-sc02-delivery'),
  );
  assertRan(delivery, [
    'claude_control::submit_delivery_tests::a_dirty_composer_is_refused_without_sending',
    'claude_control::submit_delivery_tests::a_replay_of_an_already_recorded_prompt_is_not_confirmed_by_the_old_record',
    'claude_control::submit_delivery_tests::a_confirmed_submission_is_input_sent_and_verified',
  ]);
  const composer = crateTests(
    'nession-claude-code',
    ['--lib', 'composer::'],
    600000,
    isolatedTmuxEnv('nession-4665-sc02-composer'),
  );
  assertRan(composer, [
    'composer::tests::typed_text_after_the_prompt_is_dirty',
    'composer::tests::a_long_cjk_prompt_is_dirty',
    'composer::tests::wrapped_continuation_lines_are_dirty',
    'composer::tests::an_unsent_paste_placeholder_is_dirty_even_though_styled',
  ]);
  evidence.push({
    type: 'runtime',
    value: 'a dirty composer is refused before any key is sent, a replay whose Enter was lost stays unknown because the pre-existing transcript record cannot vouch for a new delivery, and a legitimate submit against the emptied composer confirms exactly once',
  });
  return 'the no-unchecked-second-submission contract is pinned in source; the live verifier pre-fills a real Claude composer and proves refusal without append and safe reconcile';
});
