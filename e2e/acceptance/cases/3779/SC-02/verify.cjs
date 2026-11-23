'use strict';
// #3779 SC-02: `enter new|resume` selects the exact requested Claude
// conversation on a named Session; idle/in-process and Shell paths are
// verified, while busy/waiting/foreign/stale targets fail without creating a
// concurrent transcript writer.
//
// This verifier pins the Tool's mode/identity/foreign-target contracts in
// source; `verify-live.cjs` and `verify-live-shell.cjs` execute the live
// in-process and Shell paths against a real CLI. The Case is selected only by
// the `live-cli` lane (result_policy all-pass), so fixtures alone cannot Pass.
const {
  run, crateTests, assertRan, isolatedTmuxEnv,
} = require('../../../shared/mcp-cases.cjs');

run(({ evidence }) => {
  const tests = crateTests(
    'nession-claude-code',
    ['--lib', 'tools::nession_claude_enter::'],
    600000,
    isolatedTmuxEnv('nession-3779-sc02'),
  );
  assertRan(tests, [
    'tools::nession_claude_enter::tests::resume_returns_the_selected_conversation',
    'tools::nession_claude_enter::tests::new_lets_the_agent_choose_the_identity',
    'tools::nession_claude_enter::tests::new_refuses_a_caller_supplied_identity',
    'tools::nession_claude_enter::tests::resume_requires_an_explicit_conversation',
    'tools::nession_claude_enter::tests::a_foreign_target_is_refused',
    'tools::nession_claude_enter::tests::the_contract_requires_the_target_and_mode',
  ]);
  evidence.push({
    type: 'runtime',
    value: 'enter requires an explicit agent_id/session_id, `new` chooses the conversation id itself, `resume` requires an explicit conversation_id and refuses omission/blank, and a foreign Agent target is refused before any input',
  });
  return 'the enter Tool contracts are pinned in source; the live verifiers drive the in-process and Shell paths with a real CLI';
});
