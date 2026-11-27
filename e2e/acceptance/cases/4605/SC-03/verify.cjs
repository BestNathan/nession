'use strict';
// #4605 SC-03: real tmux Sessions A and B on a private socket — creation from
// a contaminated launch environment, legacy adapter artifacts, repair on
// apply/reapply and after an Agent restart, idempotent recovery, and
// preservation of the other Session's binding record, the tmux global
// environment, identities and live panes.
const { run, targetSha, checked, crateTests, assertRan, isolatedTmuxEnv } =
  require('../../../shared/mcp-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  checked('zsh', ['--version'], 5000);
  checked('tmux', ['-V'], 5000);
  // The macOS Case lane compiles the test target from a cold checkout with
  // CARGO_INCREMENTAL=0 and -D warnings; 300 s killed cargo while it was still
  // compiling. The budget covers compilation plus execution; the assertions
  // and their own bounded waits are unchanged.
  const out = crateTests(
    'nession-agent',
    ['--lib', 'tmux::env::tests::zsh_session_isolation_'],
    900000,
    isolatedTmuxEnv('nession-4605-sc03'),
  );
  assertRan(out, [
    'tmux::env::tests::zsh_session_isolation_creation_from_contaminated_provenance_uses_the_own_adapter',
    'tmux::env::tests::zsh_session_isolation_repair_preserves_other_sessions_and_is_idempotent',
    'tmux::env::tests::zsh_session_isolation_agent_restart_repairs_recorded_adapters',
    'tmux::env::tests::zsh_session_isolation_untrusted_record_stays_explicit',
  ]);
  // Bash and legacy/runtime-key non-regression: the surviving legacy Bash
  // adapter still converges, and a real Bash prompt keeps user configuration.
  const bashEnv = isolatedTmuxEnv('nession-4605-sc03-bash');
  const legacy = crateTests(
    'nession-agent',
    ['--lib', 'tmux::env::tests::a_surviving_legacy_bash_adapter_converges_after_runtime_rename'],
    300000,
    bashEnv,
  );
  assertRan(legacy, [
    'tmux::env::tests::a_surviving_legacy_bash_adapter_converges_after_runtime_rename',
  ]);
  const bash = crateTests(
    'nession-agent',
    ['--lib', 'tmux::env::tests::the_bash_adapter_converges_at_the_next_prompt_and_preserves_user_config'],
    300000,
    isolatedTmuxEnv('nession-4605-sc03-bash-prompt'),
  );
  assertRan(bash, [
    'tmux::env::tests::the_bash_adapter_converges_at_the_next_prompt_and_preserves_user_config',
  ]);
  evidence.push({
    type: 'runtime',
    value:
      'staging ' + sha + ': real tmux Sessions A and B on a private socket — the ' +
      'contaminated launch environment produced B\'s own validated adapter; a ' +
      'legacy contaminated adapter was repaired on reapply and after an Agent ' +
      'restart while A\'s profiles/revision, binding record, identities, tmux ' +
      'global environment, live panes and a legitimate legacy marker stayed ' +
      'unchanged; a repeated recovery was silent, a stale legacy marker was ' +
      'removed while NESSION_MCP_TOKEN survived, a damaged durable record stayed ' +
      'explicit with no tmux mutation, and the surviving legacy Bash adapter plus ' +
      'a real Bash prompt remained unchanged',
  });
  return 'Repair converges each Session to its own zsh baseline without disturbing others';
});
