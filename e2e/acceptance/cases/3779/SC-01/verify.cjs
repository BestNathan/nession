'use strict';
// #3779 SC-01: on-demand status from the official `claude agents --json`,
// bound to the Session's actual process, with unsupported/unobservable/
// absent/ambiguous answers never presented as a guessed state.
//
// This verifier pins the captured CLI shape and every negative answer in
// source; `verify-live.cjs` executes the positive path with a real,
// authenticated interactive CLI. The Case is selected only by the
// `live-cli` lane, and the live verifier must pass too (result_policy
// all-pass), so a run cannot Pass on fixtures alone.
const {
  run, crateTests, assertRan, isolatedTmuxEnv,
} = require('../../../shared/mcp-cases.cjs');

run(({ evidence }) => {
  const tests = crateTests(
    'nession-claude-code',
    ['--lib', 'agent_view::'],
    600000,
    isolatedTmuxEnv('nession-3779-sc01'),
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
  const identity = crateTests(
    'nession-claude-code',
    ['--lib', 'process::'],
    600000,
    isolatedTmuxEnv('nession-3779-sc01-identity'),
  );
  assertRan(identity, [
    'process::tests::the_native_npm_binary_is_the_cli',
    'process::tests::a_shell_script_wrapper_named_claude_is_the_cli',
    'process::tests::a_session_shell_adapter_path_that_mentions_claude_is_not_the_cli',
    'process::tests::an_argument_that_mentions_claude_is_not_the_cli',
  ]);
  evidence.push({
    type: 'runtime',
    value: 'the captured `agents --json` shape (2.1.326 fixture, not an admission gate) parsed into typed busy/waiting/idle and background states; unknown values survived verbatim, a missing sessionId stayed null, an unlisted version was interpreted by its answer, an older CLI without the command was unsupported, and absent/unsupported/cannot-observe were each distinct and never reported as idle; the executable/argv0/script identity rule accepts the real CLI shapes and rejects a Session adapter path or an argument that merely contains "claude"',
  });
  return 'the CLI answer parser, its non-verified observations and the Claude process identity rule are pinned in source; the live verifier drives the real CLI path';
});
