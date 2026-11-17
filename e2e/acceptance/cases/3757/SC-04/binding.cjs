'use strict';
// #3757 SC-04: a real surviving tmux Session retains its fenced Claude binding
// across a simulated Agent restart; a pre-fence Session keeps its old path.
const { run, targetSha, checked, crateTests, assertRan, isolatedTmuxEnv } =
  require('../../../shared/mcp-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  checked('tmux', ['-V'], 5000);
  const out = crateTests(
    'nession-agent',
    ['--lib', 'claude_session_context::tests::'],
    110000,
    isolatedTmuxEnv('nession-3757-sc04-binding'),
  );
  assertRan(out, [
    'claude_session_context::tests::surviving_old_fenced_session_keeps_its_claude_binding',
    'claude_session_context::tests::a_session_created_before_the_fence_still_reads_its_name_derived_binding',
    'claude_session_context::tests::a_fenced_session_ignores_a_stale_pre_fence_file',
  ]);
  evidence.push({
    type: 'runtime',
    value: 'staging ' + sha + ': real tmux legacy instance preserves Claude binding on Agent restart; pre-fence path remains readable and newer same-name Sessions reject stale files',
  });
  return 'Agent restarts and Session recreation preserve the Claude binding fence';
});
