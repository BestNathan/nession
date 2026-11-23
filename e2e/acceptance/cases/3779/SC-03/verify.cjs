'use strict';
// #3779 SC-03: `submit` inputs one prompt only into the verified idle Claude
// Session and returns its actual conversation_id and truthful delivery status;
// mismatch/unknown/concurrent/timeout replay never causes an unchecked second
// submission.
//
// This verifier pins the Tool's prompt/identity/stale-guard contracts in
// source; `verify-live.cjs` delivers a real prompt and reads the same
// conversation back. The Case is selected only by the `live-cli` lane
// (result_policy all-pass), so fixtures alone cannot Pass.
const {
  run, crateTests, assertRan, isolatedTmuxEnv,
} = require('../../../shared/mcp-cases.cjs');

run(({ evidence }) => {
  const tests = crateTests(
    'nession-claude-code',
    ['--lib', 'tools::nession_claude_submit::'],
    600000,
    isolatedTmuxEnv('nession-3779-sc03'),
  );
  assertRan(tests, [
    'tools::nession_claude_submit::tests::a_verified_submit_reports_input_sent_with_the_actual_id',
    'tools::nession_claude_submit::tests::empty_or_multi_line_prompts_are_refused',
    'tools::nession_claude_submit::tests::the_conversation_guard_is_required',
    'tools::nession_claude_submit::tests::a_foreign_target_is_refused_before_any_input',
    'tools::nession_claude_submit::tests::the_contract_requires_every_routing_and_content_field',
  ]);
  evidence.push({
    type: 'runtime',
    value: 'submit requires the verified conversation_id, refuses an empty/blank guard and empty/multi-line prompts before any input, refuses a foreign Agent target, and reports the delivery phase (`input_sent`) with the actual conversation id rather than an execution result',
  });
  return 'the submit delivery/identity contracts are pinned in source; the live verifier delivers one real prompt and reads it back from the same conversation';
});
