'use strict';
// #4605 SC-02: generated zsh wrappers in real login/interactive and nested
// processes never source another Session's adapter, run each legitimate phase
// once, keep user hooks and ENV revision convergence, and refuse an injected
// managed marker without recursion.
const { run, targetSha, checked, crateTests, assertRan, isolatedTmuxEnv } =
  require('../../../shared/mcp-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  checked('zsh', ['--version'], 5000);
  // The macOS Case lane compiles the test target from a cold checkout with
  // CARGO_INCREMENTAL=0 and -D warnings; 300 s killed cargo while it was still
  // compiling. The budget covers compilation plus execution; the assertions
  // and their own bounded waits are unchanged.
  const out = crateTests(
    'nession-agent',
    ['--lib', 'tmux::env::tests::zsh_contamination_'],
    900000,
    isolatedTmuxEnv('nession-4605-sc02'),
  );
  assertRan(out, [
    'tmux::env::tests::zsh_contamination_across_sessions_never_recurses',
    'tmux::env::tests::zsh_contamination_injected_marker_is_refused',
    'tmux::env::tests::zsh_contamination_missing_marker_falls_back_to_home',
    'tmux::env::tests::zsh_contamination_nested_shell_initializes_once',
  ]);
  evidence.push({
    type: 'runtime',
    value:
      'staging ' + sha + ': a real zsh A->B contamination fixture finished within ' +
      'the bounded wait, sourced each user startup phase once, reached the prompt ' +
      'sentinel with the user precmd hook and revision sync intact, ran a nested ' +
      'non-interactive shell through .zshenv once without .zshrc, and refused a ' +
      'directly injected managed marker without recursion',
  });
  return 'Generated zsh wrappers refuse cross-Session adapters and initialize once per phase';
});
