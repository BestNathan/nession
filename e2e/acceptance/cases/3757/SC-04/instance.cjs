'use strict';
// #3757 SC-04: a pre-upgrade tmux Session UUID is still adopted when the
// new marker is absent, without synthesizing another instance identity.
const { run, targetSha, crateTests, assertRan, isolatedTmuxEnv } =
  require('../../../shared/mcp-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const out = crateTests(
    'nession-agent',
    ['--lib', 'a_legacy_instance_marker_is_adopted_after_upgrade'],
    110000,
    isolatedTmuxEnv('nession-3757-sc04-instance'),
  );
  assertRan(out, [
    'tmux::manager::injected_tmux_tests::a_legacy_instance_marker_is_adopted_after_upgrade',
  ]);
  evidence.push({
    type: 'runtime',
    value: 'staging ' + sha + ': an old tmux environment marker is adopted into the durable instance-id option without inventing a new identity',
  });
  return 'Legacy marker and canonical identity remain consistent after Agent update';
});
