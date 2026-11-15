'use strict';
// #3507 SC-02: the TerminalController route must refuse a pending OSC 5522
// write once clipboard authority is lost (background tab or read-only
// observer), while the authorized write path and the existing #3395 read/
// listing protections stay intact.
const {
  run,
  targetSha,
  webVitestFiles,
} = require('../../../shared/web-vitest-cases.cjs');

const FILE =
  'src/platform/terminal-runtime/controller/__tests__/integration/TerminalControllerClipboard.test.ts';
const TESTS = [
  'cannot apply a pending OSC 5522 write after clipboard authority is lost (#3507)',
  'withholds offered MIME metadata after the controller loses clipboard authority (#3395)',
];

run(({ evidence }) => {
  const sha = targetSha();
  webVitestFiles([FILE], TESTS, { project: 'integration' });
  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': with document.visibilityState=hidden a pending chunked write ' +
      'replied only EPERM and invoked no clipboard effect; a read-only observer transition ' +
      'applied nothing and emitted no PTY bytes; the authorized controller still applied the ' +
      'identical MIME payload and replied DONE, and the #3395 MIME listing still withheld ' +
      'offer metadata after authority loss',
  });
  return 'The controller/protocol route denies completed OSC 5522 writes after authority loss and keeps the authorized write and read/listing protections intact';
});
