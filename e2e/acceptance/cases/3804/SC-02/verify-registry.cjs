'use strict';
// #3804 SC-02 (server half): delayed/duplicate levels, same-name incarnation
// replacement and a racing force refresh are fenced away from a newer level.
const { run, targetSha, crateTests, assertRan } = require('../../../shared/control-mode-cases.cjs');

const TESTS = [
  'activity_is_fenced_by_incarnation_epoch_and_generation',
  'inventory_updates_and_force_refresh_preserve_same_incarnation_activity',
];

run(({ evidence }) => {
  const sha = targetSha();
  const output = crateTests('nession-server', ['--lib', 'registry::session::tests'], 90000);
  assertRan(output, TESTS);
  evidence.push({
    type: 'runtime',
    value:
      `exact SHA ${sha}: a duplicate or older generation and a different ` +
      'Session incarnation were refused, a new Agent epoch was accepted, and ' +
      'both an inventory update and a force refresh preserved the same-' +
      'incarnation level while a same-name replacement inherited nothing',
  });
  return 'The Server projection fences stale levels but a resync cannot erase the current one';
});
