'use strict';
// #3344 SC-01: an ambiguous duplicate create (closed reply channel or elapsed
// deadline, with a profile or with none) targets an already-live Session and
// must preserve that Session's instance, desired binding and revision.
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
    'ambiguous_duplicate_disconnect_preserves_the_existing_binding',
    'ambiguous_duplicate_disconnect_without_profiles_preserves_the_existing_binding',
    'ambiguous_duplicate_timeout_preserves_the_existing_binding',
    'ambiguous_duplicate_timeout_without_profiles_preserves_the_existing_binding',
  ];
  assertRan(output, names);
  evidence.push({
    type: 'runtime',
    value: 'exact SHA ' + sha + ': ' + names.join('; ') + ' each Passed in the target checkout',
  });
  return 'Ambiguous duplicate create replies preserve the live Session instance, desired binding and revision';
});
