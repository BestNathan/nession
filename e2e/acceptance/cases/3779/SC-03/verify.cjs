'use strict';
// #3779 SC-03: `submit` inputs one prompt only into the verified idle Claude
// Session and returns its actual conversation_id and truthful delivery status;
// mismatch/unknown/concurrent/timeout replay never causes an unchecked second
// submission.
//
// The deterministic Tool contracts prove prompt/identity/stale-guard refusal.
// SCN-03's live delivery proof needs an interactive authenticated Claude runtime
// this Case runner does not provide, so the criterion stays Pending.
const {
  run, crateTests, assertRan, isolatedTmuxEnv,
} = require('../../../shared/mcp-cases.cjs');
const { pendingRealCli } = require('../../../shared/claude-cases.cjs');

const env = isolatedTmuxEnv('nession-3779-sc03');
const evidence = [];

try {
  const tests = crateTests(
    'nession-claude-code',
    ['--lib', 'tools::nession_claude_submit::'],
    600000,
    env,
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
} catch (error) {
  run(() => {
    throw error;
  });
  return;
}

pendingRealCli(
  evidence,
  'The live one-prompt delivery, verified actual-id, busy/stale refusal and timeout read-back paths therefore remain unproven at this stage.',
);
