'use strict';
// #2598 SC-03 (runtime half): the protocol owner's exact unit suite proves the
// write state machine behind the browser case — chunking, aliases, strict
// base64, bounds, concurrency and replies.
const path = require('node:path');
const {
  root, stripAnsi, passedTests, checkedIn,
} = require('../../../shared/terminal-sizing-cases.cjs');
const { run, targetSha } = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const output = stripAnsi(checkedIn(
    path.join(root, 'web'),
    'npm',
    ['test', '--', '--project', 'unit',
      'src/platform/terminal-runtime/clipboard/__tests__/unit/ClipboardProtocol.test.ts'],
    600000,
  ));
  const passed = passedTests(output) ?? 0;
  if (passed < 30) {
    throw new Error('the clipboard protocol unit suite did not run (' + passed + '): ' +
      output.slice(-3000));
  }
  evidence.push({
    type: 'test',
    value: 'exact SHA ' + sha + ': ' + passed + ' protocol unit tests passed (strict base64, ' +
      'write chunking/aliases, EINVAL/EFBIG/EBUSY/EPERM/EIO replies, ids, one-time reads, ' +
      '64 MiB streamed write)',
  });
  return 'The OSC 52/5522 write state machine is proven by its exact unit suite';
});
