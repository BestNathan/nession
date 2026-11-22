'use strict';
// #3804 SC-02 (agent half): an unchanged level is not republished, and a full
// reconnect resync restates the actual current level.
const { run, targetSha, cargoTests, assertRan } = require('../../../shared/control-mode-cases.cjs');

const TEST = 'activity_is_published_on_change_and_restated_by_a_full_resync';

run(({ evidence }) => {
  const sha = targetSha();
  const output = cargoTests(
    ['--lib', 'sync::session_watcher::enumeration_failure::activity_is_published'],
    90000,
  );
  assertRan(output, [TEST]);
  evidence.push({
    type: 'runtime',
    value:
      `exact SHA ${sha}: an unchanged level produced no second frame, a real ` +
      'change produced generation 2, and a reconnect resync restated the ' +
      'current idle level as generation 3 without a browser attach',
  });
  return 'Activity is a replaced level that a reconnect resync restores without browser participation';
});
