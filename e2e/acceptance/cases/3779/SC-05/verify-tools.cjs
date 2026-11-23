'use strict';
// #3779 SC-05 (1/4): every Tool owns one target-validation rule and one closed
// typed contract. A Tool that loses its guard or typed output cannot be hidden
// by the others.
//
// The Case owns several verifier steps because the single-verifier form
// exceeded the runner's per-process verification window once the Rust test
// profile was cold (#3779 acceptance run 44310361123). `result_policy:
// all-pass` keeps every step mandatory; this split changes no assertion.
const {
  run, targetSha, crateTests, assertRan, isolatedTmuxEnv,
} = require('../../../shared/mcp-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const tools = crateTests(
    'nession-claude-code',
    ['--lib', 'tools::nession_claude_'],
    600000,
    isolatedTmuxEnv('nession-3779-sc05-tools'),
  );
  assertRan(tools, [
    'tools::nession_claude_status::tests::a_foreign_agent_is_refused_not_observed_locally',
    'tools::nession_claude_status::tests::both_identity_fields_are_required_and_unexpected_keys_are_refused',
    'tools::nession_claude_enter::tests::a_foreign_target_is_refused',
    'tools::nession_claude_enter::tests::the_contract_requires_the_target_and_mode',
    'tools::nession_claude_submit::tests::a_foreign_target_is_refused_before_any_input',
    'tools::nession_claude_submit::tests::the_contract_requires_every_routing_and_content_field',
    'tools::nession_claude_list_conversations::tests::foreign_and_malformed_targets_are_refused_before_any_read',
    'tools::nession_claude_list_conversations::tests::the_contract_requires_the_target_and_advertises_the_unit_output',
    'tools::nession_claude_get_conversation::tests::a_missing_foreign_or_blank_identity_is_refused_before_any_read',
    'tools::nession_claude_get_conversation::tests::the_contract_requires_the_conversation_and_advertises_the_unit_output',
    'tools::nession_claude_get_transcript::tests::the_two_modes_cannot_be_mixed_or_defaulted',
    'tools::nession_claude_get_transcript::tests::the_contract_advertises_both_modes_without_exposing_a_path',
  ]);
  evidence.push({
    type: 'runtime',
    value: 'exact SHA ' + sha + ': each of the six Claude Tools refused a foreign Agent/Session target and advertised a closed typed input contract with its Unit-owned output schema',
  });
  return 'each of the six Tools enforces its explicit target and closed typed contract';
});
