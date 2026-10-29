'use strict';
// #2598 SC-07: the OSC 5522 deterministic fixture (unit + integration suites)
// proves capability query, enable/disable, MIME announcement, read, write/wdata,
// chunked OK/DATA/DONE, valid base64/padding, multiplexer ids, 64 MiB writes and
// the documented errors with bounded resources.
const path = require('node:path');
const fs = require('node:fs');
const {
  root, stripAnsi, passedTests, checkedIn, requireText,
} = require('../../../shared/terminal-sizing-cases.cjs');
const { run, targetSha } = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const owner = 'web/src/platform/terminal-runtime/clipboard/ClipboardProtocol.ts';
  requireText(owner, [
    'KITTY_MIN_CLIPBOARD_WRITE_BYTES',
    '64 * 1024 * 1024',
    'CLIPBOARD_PACKET_BYTES',
    '4096',
    'EINVAL',
    'EFBIG',
    'EBUSY',
    'EPERM',
    'EIO',
    'walias',
    'userPasted',
  ]);
  const tests = fs.readFileSync(
    path.join(root, 'web/src/platform/terminal-runtime/clipboard/__tests__/unit/ClipboardProtocol.test.ts'),
    'utf8',
  );
  for (const needle of [
    'accepts a 64 MiB clipboard write at the protocol bound',
    'applies multiple MIME types and aliases as one clipboard write',
    'serves a one-time read only with the paste password',
    'replies the paste-event mode truthfully through DECRQM',
    'replies EBUSY while another write is in flight',
  ]) {
    if (!tests.includes(needle)) {
      throw new Error('the protocol conformance suite lost the case: ' + needle);
    }
  }

  const unit = stripAnsi(checkedIn(
    path.join(root, 'web'),
    'npm',
    ['test', '--', '--project', 'unit',
      'src/platform/terminal-runtime/clipboard/__tests__/unit/ClipboardProtocol.test.ts'],
    900000,
  ));
  const unitPassed = passedTests(unit) ?? 0;
  if (unitPassed < 30) {
    throw new Error('the protocol unit suite did not run: ' + unit.slice(-3000));
  }
  const integration = stripAnsi(checkedIn(
    path.join(root, 'web'),
    'npm',
    ['test', '--', '--project', 'integration',
      'src/platform/terminal-runtime/clipboard/__tests__/integration/XtermClipboardBinding.test.ts'],
    600000,
  ));
  const integrationPassed = passedTests(integration) ?? 0;
  if (integrationPassed < 5) {
    throw new Error('the parser-binding integration suite did not run: ' + integration.slice(-3000));
  }
  evidence.push({
    type: 'test',
    value: 'exact SHA ' + sha + ': ' + unitPassed + ' protocol unit tests and ' +
      integrationPassed + ' real-parser integration tests passed; the suite includes the 64 MiB ' +
      'streamed write, aliases, one-time reads, DECRQM truth and EBUSY contention',
  });
  return 'The OSC 5522 deterministic protocol fixture conformance suite passes';
});
