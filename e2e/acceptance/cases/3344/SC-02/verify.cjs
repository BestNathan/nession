'use strict';
// #3344 SC-02: a genuinely new Session keeps the ambiguous-create recovery
// semantics (the Agent may have created it), while a later authoritative
// duplicate refusal must never replace the reconciled binding.
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
    'ambiguous_new_create_disconnect_applies_the_staged_binding',
    'ambiguous_new_create_timeout_applies_the_staged_binding',
    'ambiguous_new_create_disconnect_without_profiles_clears_a_stale_row',
    'authoritative_refusal_preserves_the_ambiguous_new_create_binding',
  ];
  assertRan(output, names);
  evidence.push({
    type: 'runtime',
    value: 'exact SHA ' + sha + ': ' + names.join('; ') + ' each Passed in the target checkout',
  });
  return 'A genuinely new ambiguous create keeps its staged binding; a later authoritative refusal never replaces it';
});
