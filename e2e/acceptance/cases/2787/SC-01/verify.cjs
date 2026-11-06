'use strict';
// #2787 SC-01: two same-Session reads complete R2 then R1; the UI ends on R2's
// data and never regresses to R1's, including when R2 was a manual Refresh and
// when two manual Refreshes overlap.
const { run, targetSha, webVitest } = require('../../../shared/web-vitest-cases.cjs');

const FILE = 'src/capabilities/git/__tests__/integration/useGitRequest.test.tsx';
const TESTS = [
  'keeps the newer manual refresh after the older mount read resolves late (SC-01)',
  'keeps the newest of two overlapping manual refreshes, including its loading state (SC-01/02)',
];

run(({ evidence }) => {
  const sha = targetSha();
  webVitest(FILE, TESTS);
  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': deferred-response hook tests resolved R2 before ' +
      'R1 for one Session/generation; the committed state stayed on R2 with no ' +
      'A-after-B transition, and two overlapping manual refreshes kept the ' +
      'newest data and its loading ownership',
  });
  return 'The latest-started same-Session read is the only one that publishes; a manual Refresh cannot be overwritten by an older in-flight read';
});
