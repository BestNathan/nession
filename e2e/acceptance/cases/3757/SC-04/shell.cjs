'use strict';
// #3757 SC-04: the old Bash shell adapter stored in a surviving Session keeps
// reading the same ENV runtime/revision files after Agent namespace migration.
const { run, targetSha, checked, crateTests, assertRan, isolatedTmuxEnv } =
  require('../../../shared/mcp-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  checked('bash', ['--version'], 5000);
  const out = crateTests(
    'nession-agent',
    ['--lib', 'a_surviving_legacy_bash_adapter_converges_after_runtime_rename'],
    110000,
    isolatedTmuxEnv('nession-3757-sc04-shell'),
  );
  assertRan(out, [
    'tmux::env::tests::a_surviving_legacy_bash_adapter_converges_after_runtime_rename',
  ]);
  evidence.push({
    type: 'runtime',
    value: 'staging ' + sha + ': surviving Bash adapter with legacy variable names consumed revision 1 then revision 2 and recorded the new shell revision without changing its old hook',
  });
  return 'Surviving Bash ENV adapter continues revision convergence after migration';
});
