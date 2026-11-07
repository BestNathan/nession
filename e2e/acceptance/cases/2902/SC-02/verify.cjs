'use strict';
// #2902 SC-02: once flight A is superseded by B, A settling late cannot change
// B's content, progress, loading, error or cancel handle; B stays cancellable
// and its eventual result is the one the viewer keeps.
const { run, targetSha, webVitest } = require('../../../shared/web-vitest-cases.cjs');

const FILE = 'src/capabilities/files/hooks/__tests__/integration/useFileViewer.chunked.test.tsx';
const TESTS = [
  'a superseded flight cannot publish over the newer load, whose result is authoritative (SC-02)',
  'keeps the newer flight cancellable after the superseded flight settles (SC-02)',
];

run(({ evidence }) => {
  const sha = targetSha();
  webVitest(FILE, TESTS);
  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': flight A resolved after flight B started and changed none of B\'s ' +
      'content/progress/loading/error; B remained cancellable, and B\'s own result was committed',
  });
  return (
    'Only the current load generation publishes; a superseded flight cannot mutate or uncancel its successor'
  );
});
