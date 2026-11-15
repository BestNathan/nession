'use strict';
// #3507 SC-01: an OSC 5522 write begun while authorized must recheck live
// authorization when the final packet completes it. Losing authority before
// completion must deny the effect with EPERM instead of DONE, while an
// otherwise identical authorized write still applies its payload.
const {
  run,
  targetSha,
  webVitestFiles,
} = require('../../../shared/web-vitest-cases.cjs');

const FILE = 'src/platform/terminal-runtime/clipboard/__tests__/unit/ClipboardProtocol.test.ts';
const TESTS = [
  'refuses a write completed after the client loses authorization (#3507)',
  'accepts one chunked MIME write with aliases and replies DONE with the id',
];

run(({ evidence }) => {
  const sha = targetSha();
  webVitestFiles([FILE], TESTS, { project: 'unit' });
  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': a chunked OSC 5522 write started while authorized and completed ' +
      'after isAuthorized=false invoked no clipboard effect and replied only EPERM; an ' +
      'authorized chunked MIME write still applied its payload and replied DONE',
  });
  return 'A completed OSC 5522 write requires live authorization, refuses the closing packet after authority loss, and keeps the authorized write path intact';
});
