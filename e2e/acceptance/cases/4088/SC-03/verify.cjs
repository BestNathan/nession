'use strict';
// #4088 SC-03 (SCN-03): the read-only loopback Registry denies every mutation
// verb even with a valid push credential, requires authorization, and denies
// cross-repository blob/manifest access even though the bytes are physically in
// the local CAS (possession is not authorization). The Agent-like cache host
// serves pull over loopback and denies push.
const {
  run, targetSha, crateTests, assertRan,
} = require('../../../shared/control-mode-cases.cjs');

const TEST = 'sc03_loopback_readonly_and_repository_scope';
const MEASURED = /^#4088 SC-03 measured: .*$/m;

run(({ evidence }) => {
  const sha = targetSha();
  const output = crateTests(
    'nession-erofs',
    ['--lib', '--features', 'cache,registry', TEST],
    600000,
  );
  assertRan(output, [TEST]);
  const measured = output.match(MEASURED);
  if (!measured) throw new Error('the SC-03 loopback scope measurement line was not emitted');
  evidence.push({ type: 'runtime', value: 'exact SHA ' + sha + ': ' + measured[0] });
  return 'SC-03: the read-only loopback Registry denies all mutation verbs and cross-repository access despite local CAS bytes, requires authorization, and the Agent cache host pulls but cannot push';
});