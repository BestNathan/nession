'use strict';
// #2864 SC-02: an event committed while a directory load is pending survives
// the older response, and a later explicit refresh converges to the provider.
const { run, checked, targetSha } = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const result = checked(
    'npm',
    [
      '--prefix', 'web', 'test', '--',
      'src/platform/explorer/__tests__/unit/ExplorerStore.test.ts',
      '--testNamePattern',
      'replays create events|replays delete and rename events|converges to a fresh provider snapshot|' +
        'settles a renamed directory',
      '--run',
    ],
    300000,
  );
  const clean = result.replace(/\x1b\[[0-9;]*m/g, '');
  if (!/Test Files\s+1 passed/.test(clean) || !/Tests\s+4 passed/.test(clean)) {
    throw new Error('the event-overlap witnesses did not pass: ' + result.slice(-4000));
  }
  evidence.push({
    type: 'test',
    value:
      'exact SHA ' + sha + ': ExplorerStore.test.ts create/delete/rename replay tests passed while a ' +
      'directory load was pending; an older response cannot undo the event, and an explicit fresh ' +
      'refresh converges to the provider snapshot',
  });
  return 'Events committed during a pending load survive the older response and a fresh refresh converges';
});
