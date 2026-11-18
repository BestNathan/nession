'use strict';
// #3779 SC-01: on-demand status from the official `claude agents --json`,
// bound to the Session's actual process, with unsupported/unobservable/
// absent/ambiguous answers never presented as a guessed state.
//
// The deterministic fixtures pin the captured CLI shape and every negative
// answer. SCN-03's positive path needs a live, authenticated interactive
// Claude in a Nession Session, which this Case runner does not provide, so the
// criterion stays Pending rather than substituting a fixture for that claim.
const {
  run, crateTests, assertRan, isolatedTmuxEnv,
} = require('../../../shared/mcp-cases.cjs');
const { pendingRealCli } = require('../../../shared/claude-cases.cjs');

const env = isolatedTmuxEnv('nession-3779-sc01');
const evidence = [];

try {
  const tests = crateTests(
    'nession-claude-code',
    ['--lib', 'agent_view::'],
    600000,
    env,
  );
  assertRan(tests, [
    'agent_view::tests::the_supported_path_reports_the_captured_records',
    'agent_view::tests::the_observed_shape_parses_into_typed_states',
    'agent_view::tests::unknown_status_and_state_survive_verbatim',
    'agent_view::tests::a_missing_conversation_id_is_none_not_a_guess',
    'agent_view::tests::the_same_answer_parses_whatever_version_reports_it',
    'agent_view::tests::an_unlisted_version_is_interpreted_by_its_answer',
    'agent_view::tests::an_unreadable_version_does_not_hide_a_valid_answer',
    'agent_view::tests::an_older_cli_without_the_command_is_unsupported',
    'agent_view::tests::a_cli_without_the_command_is_unsupported',
    'agent_view::tests::a_failed_run_is_cannot_observe_not_absent_claude',
    'agent_view::tests::a_missing_binary_is_absent',
    'agent_view::tests::malformed_or_non_array_output_is_cannot_observe',
  ]);
  evidence.push({
    type: 'runtime',
    value: 'the captured `agents --json` shape parsed into typed busy/waiting/idle and background states; unknown values survived verbatim, a missing sessionId stayed null, an unlisted version was interpreted by its answer, an older CLI without the command was unsupported, and absent/unsupported/cannot-observe were each distinct and never reported as idle',
  });
} catch (error) {
  run(() => {
    throw error;
  });
  return;
}

pendingRealCli(
  evidence,
  'The on-demand status probe against a live PID-matched Session therefore remains unproven at this stage.',
);
