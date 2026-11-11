'use strict';
// #3189 SC-02: simultaneously mounted history consumers share one reactive
// owner; add/remove/clear propagate without remount, the 500-entry bound holds,
// and a stale consumer cannot resurrect a removed entry.
const {
  run,
  targetSha,
  webVitest,
} = require('../../../shared/web-vitest-cases.cjs');

const FILE = 'src/product/terminal/hooks/__tests__/integration/useCommandHistory.test.ts';
const TESTS = [
  'shares one reactive history between simultaneously mounted consumers (#3189 SC-02)',
  'applies the 500-entry bound across consumers without stale resurrection (#3189 SC-02)',
  'refreshes from another tab storage event (#3189 SC-02)',
];

run(({ evidence }) => {
  const sha = targetSha();
  webVitest(FILE, TESTS);
  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': two mounted consumers observed add/remove/clear from ' +
      'one owner; 510 inserts stayed bounded at 500; a removed entry never returned; ' +
      'a cross-tab storage event refreshed the mounted consumer',
  });
  return 'All mounted command-history consumers share one reactive owner with bounded persistence and no stale resurrection';
});
