'use strict';
// #3395 SC-01: after a paste offer exists, losing current Controller
// authorization must not disclose its MIME listing through OSC 5522
// `type=read` with `.`. The authorized passwordless listing keeps working and
// password reads still require authorization plus the one-time password.
const {
  run,
  targetSha,
  webVitestFiles,
} = require('../../../shared/web-vitest-cases.cjs');

const FILE = 'src/platform/terminal-runtime/clipboard/__tests__/unit/ClipboardProtocol.test.ts';
const TESTS = [
  'answers a MIME listing without a password and lists offered types',
  'refuses a MIME listing after the client loses authorization (#3395)',
  'refuses an offered payload after the client loses authorization (#3395)',
  'refuses a read with no preceding user paste',
];

run(({ evidence }) => {
  const sha = targetSha();
  webVitestFiles([FILE], TESTS, { project: 'unit' });
  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': an authorized passwordless listing returned the offered ' +
      'text/plain and image/png names; after isAuthorized=false the listing returned only ' +
      'EPERM with no OK/DATA/DONE; a passwordless read still failed; a password read ' +
      'after authorization loss returned EPERM',
  });
  return 'MIME listing requires current controller authorization while the authorized listing and password-gated payload read semantics are unchanged';
});
