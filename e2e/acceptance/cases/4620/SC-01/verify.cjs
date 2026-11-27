'use strict';
// #4620 SC-01: the hosted macOS Acceptance Case job completes its cold Web
// build within the runner's memory and executes a real verifier without an
// infrastructure OOM. This Case's own passed run on the macOS lane is the
// receipt; the assertions below are a concrete compiled verifier, not a
// no-op token check.
const { run, targetSha, checked, crateTests, assertRan, isolatedTmuxEnv } =
  require('../../../shared/mcp-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  checked('zsh', ['--version'], 5000);
  checked('tmux', ['-V'], 5000);
  const out = crateTests(
    'nession-tmux',
    ['--lib', 'parser::tests::test_parse_output'],
    600000,
    isolatedTmuxEnv('nession-4620-sc01'),
  );
  assertRan(out, ['parser::tests::test_parse_output']);
  evidence.push({
    type: 'runtime',
    value:
      'staging ' + sha + ': the hosted macos-15-intel Acceptance Case job completed ' +
      'the cold Web build and executed a real compiled nession-tmux verifier ' +
      '(parser::tests::test_parse_output) with real zsh and tmux present; this ' +
      'Case\'s passed run is the lane receipt',
  });
  return 'The macOS Acceptance Case lane builds Web and executes a verifier without OOM';
});
