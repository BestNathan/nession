'use strict';
// #3757 SC-01: an explicit Session ENV Profile reaches the actual tmux
// environment, while the internal instance marker cannot be overridden.
const { run, targetSha, checked, crateTests, assertRan, isolatedTmuxEnv } =
  require('../../../shared/mcp-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  checked('tmux', ['-V'], 5000);
  const out = crateTests(
    'nession-agent',
    ['--lib', 'mcp_token_profile_materializes_in_real_tmux_without_spoofing_identity'],
    110000,
    isolatedTmuxEnv('nession-3757-sc01-env'),
  );
  assertRan(out, [
    'tmux::env::tests::mcp_token_profile_materializes_in_real_tmux_without_spoofing_identity',
  ]);
  evidence.push({
    type: 'runtime',
    value: 'staging ' + sha + ': actual isolated tmux Session observed explicitly bound NESSION_MCP_TOKEN; rejected runtime instance override and preserved the UUID fence',
  });
  return 'The Session binder permits the credential and protects runtime identity in tmux';
});
