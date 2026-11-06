'use strict';
// #2787 SC-02: an older read's late error or success cannot overwrite the newer
// read's terminal state. Target switch, reconnect and invalidation continue to
// reject stale responses, and the latest read still finishes normally.
const { run, targetSha, webVitest } = require('../../../shared/web-vitest-cases.cjs');

const FILE = 'src/capabilities/git/__tests__/integration/useGitRequest.test.tsx';
const TESTS = [
  'does not let an older failure clear the newer success (SC-02)',
  'does not let an older success replace the newer error (SC-02)',
  'rejects the previous Session’s late response and still completes the new target’s read (SC-02)',
  'rejects a response that was in flight across a reconnect and completes the post-reconnect read (SC-02)',
  'starts a fresh read on invalidation, ignores stale epochs and rejects the invalidated read (SC-02)',
];

run(({ evidence }) => {
  const sha = targetSha();
  webVitest(FILE, TESTS);
  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': an older late error/success could not replace the ' +
      'newer success/error; the previous Session, a pre-reconnect read and an ' +
      'invalidated read were rejected while the latest generation completed ' +
      'normally; stale invalidation epochs were ignored',
  });
  return 'Late stale terminal states cannot override a newer result, and target-switch, reconnect and invalidation generations still reject superseded reads';
});
