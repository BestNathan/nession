'use strict';
// #2999 SC-01 (pinned half): the canonical Server handler tests run against the
// exact target checkout. The live half proves the real Server/Agent path; this
// half pins the staged-candidate logic itself.
const {
  run,
  targetSha,
  crateTests,
  assertRan,
} = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const output = crateTests('nession-server', ['--lib', 'server_session_create_v1'], 300_000);
  const names = [
    'duplicate_create_with_profiles_preserves_the_existing_binding',
    'duplicate_create_without_profiles_preserves_the_existing_binding',
    'successful_create_applies_the_staged_binding_after_the_agent_confirms',
    'successful_create_without_profiles_clears_a_stale_row',
  ];
  assertRan(output, names);
  evidence.push({
    type: 'runtime',
    value: 'exact SHA ' + sha + ': ' + names.join('; ') + ' each Passed in the target checkout',
  });
  return 'A refused create never mutates the existing binding; a confirmed create applies the staged binding, and an empty confirmed create clears only a stale row';
});
