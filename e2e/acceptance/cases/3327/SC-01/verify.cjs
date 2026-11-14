'use strict';
// #3327 SC-01: one deferred Git mutation settles after the Session moved from
// A to B. Success, repository_changed and transport failure must all leave B's
// status, notice and busy state untouched; B's own stage completes normally;
// A's commit retry identity is retained for its own Session.
const { run, targetSha, webVitest } = require('../../../shared/web-vitest-cases.cjs');

const FILE = 'src/capabilities/git/__tests__/integration/useGitMutations.test.tsx';
const TESTS = [
  'a late stage success from the previous Session never overwrites B, and B owns its own stage (#3327 SC-01)',
  'a late repository_changed answer from the previous Session never replaces B or shows its notice (#3327 SC-01)',
  'a late transport failure from the previous Session never appears in B (#3327 SC-01)',
  'a late commit from A cannot clear B busy or replace B, and A keeps its retry identity (#3327 SC-01)',
];

run(({ evidence }) => {
  const sha = targetSha();
  webVitest(FILE, TESTS);
  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': A stage success, repository_changed and transport failure ' +
      'settled after the Session moved to B without changing B; B\'s own stage adopted its ' +
      'post-state; A\'s commit retry reused its dispatch-time request identity',
  });
  return 'A deferred Git mutation from the previous Session cannot change the current Session; same-Session adoption and A retry identity remain intact';
});
