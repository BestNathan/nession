'use strict';
// #3779 SC-02: `enter new|resume` selects the exact requested Claude
// conversation on a named Session; idle/in-process and Shell paths are
// verified, while busy/waiting/foreign/stale targets fail without creating a
// concurrent transcript writer.
//
// The deterministic Tool contracts prove mode/identity/foreign-target refusal.
// SCN-03's live interactive Claude paths need a runner this Case does not have,
// so the criterion stays Pending instead of claiming them.
const {
  run, crateTests, assertRan, isolatedTmuxEnv,
} = require('../../../shared/mcp-cases.cjs');
const { pendingRealCli } = require('../../../shared/claude-cases.cjs');

const env = isolatedTmuxEnv('nession-3779-sc02');
const evidence = [];

try {
  const tests = crateTests(
    'nession-claude-code',
    ['--lib', 'tools::nession_claude_enter::'],
    600000,
    env,
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
} catch (error) {
  run(() => {
    throw error;
  });
  return;
}

pendingRealCli(
  evidence,
  'The live Shell-launch, in-process /clear && /resume, busy/waiting refusal and one-writer paths therefore remain unproven at this stage.',
);
