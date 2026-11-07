'use strict';
// #2902 SC-01: cancelling a chunked load while its final chunk is in flight
// must settle non-loading and never commit that chunk as content.
const { run, targetSha, webVitest } = require('../../../shared/web-vitest-cases.cjs');

const FILE = 'src/capabilities/files/hooks/__tests__/integration/useFileViewer.chunked.test.tsx';
const TESTS = [
  'cancelling while the final chunk is in flight settles without committing it (SC-01)',
];

run(({ evidence }) => {
  const sha = targetSha();
  webVitest(FILE, TESTS);
  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': a deferred final chunk settled after Cancel; the hook left loading, ' +
      'committed no content/progress/error, and the cancelled reader rejected as AbortError',
  });
  return (
    'Cancel settles the viewer without allowing the in-flight final chunk to publish content or loading'
  );
});
