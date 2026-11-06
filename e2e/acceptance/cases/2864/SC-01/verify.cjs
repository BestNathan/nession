'use strict';
// #2864 SC-01: newest-first directory loads must commit only the newest
// snapshot; stale success or failure cannot alter tree, load state, selection
// or the active node.
const { run, checked, targetSha } = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const result = checked(
    'npm',
    [
      '--prefix', 'web', 'test', '--',
      'src/platform/explorer/__tests__/unit/ExplorerStore.test.ts',
      '--testNamePattern', 'commits only the newest load',
      '--run',
    ],
    300000,
  );
  const clean = result.replace(/\x1b\[[0-9;]*m/g, '');
  if (!/Test Files\s+1 passed/.test(clean) || !/Tests\s+1 passed/.test(clean)) {
    throw new Error('the newest-load witness did not pass: ' + result.slice(-4000));
  }
  evidence.push({
    type: 'test',
    value:
      'exact SHA ' + sha + ': ExplorerStore.test.ts "commits only the newest load when responses resolve ' +
      'newest-first (#2864)" passed; the older response is inert after a newer snapshot commits, and a ' +
      'stale failure or success cannot change children, load state, selection or the active node',
  });
  return 'Only the newest directory snapshot commits; stale success and failure are inert';
});
