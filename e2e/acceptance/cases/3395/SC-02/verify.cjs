'use strict';
// #3395 SC-02: the existing TerminalController/protocol integration route must
// not emit offered MIME listing DATA once the controller loses clipboard
// authority (background tab or read-only observer), while the authorized
// controller's ordinary paste/read announcement and listing stay intact.
const {
  run,
  targetSha,
  webVitestFiles,
} = require('../../../shared/web-vitest-cases.cjs');

const FILE =
  'src/platform/terminal-runtime/controller/__tests__/integration/TerminalControllerClipboard.test.ts';
const TESTS = [
  'withholds offered MIME metadata after the controller loses clipboard authority (#3395)',
  'announces an image-only paste once the TUI negotiated mode 5522',
  'never performs effects or replies for an observer',
];

run(({ evidence }) => {
  const sha = targetSha();
  webVitestFiles([FILE], TESTS, { project: 'integration' });
  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': an authorized live controller announced its one-time image offer; ' +
      'with document.visibilityState=hidden the remote listing received only EPERM and no ' +
      'status=DATA or image/png metadata; a read-only observer transition emitted no PTY ' +
      'bytes; after restoring authority the ordinary listing returned OK/DATA/DONE',
  });
  return 'The controller/protocol route withholds offered MIME listing data from unauthorized transitions and keeps the authorized paste/read flow intact';
});
