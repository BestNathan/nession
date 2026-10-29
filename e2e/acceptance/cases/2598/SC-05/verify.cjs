'use strict';
// #2598 SC-05 (runtime half): the ordered writer carries the provenance the
// protocol consumes, and the controller-level clipboard suite proves the
// replay/observer/epoch refusals on the production classes.
const path = require('node:path');
const fs = require('node:fs');
const {
  root, stripAnsi, passedTests, checkedIn, requireText,
} = require('../../../shared/terminal-sizing-cases.cjs');
const { run, targetSha } = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  requireText('web/src/platform/terminal-runtime/controller/SerializedTerminalWriter.ts', [
    'TerminalWriteOrigin',
    'item.origin',
  ]);
  requireText('web/src/platform/terminal-runtime/controller/TerminalController.ts', [
    "source: 'replay'",
    'resetStreamEpoch',
    'canEffectClipboard',
  ]);
  if (!fs.existsSync(path.join(root, 'web/src/platform/terminal-runtime/clipboard/ClipboardProtocol.ts'))) {
    throw new Error('the clipboard protocol owner is missing');
  }

  const files = [
    'src/platform/terminal-runtime/clipboard/__tests__/unit/ClipboardProtocol.test.ts',
    'src/platform/terminal-runtime/clipboard/__tests__/integration/XtermClipboardBinding.test.ts',
    'src/platform/terminal-runtime/controller/__tests__/integration/TerminalControllerClipboard.test.ts',
  ];
  let total = 0;
  for (const file of files) {
    const project = file.includes('/unit/') ? 'unit' : 'integration';
    const output = stripAnsi(checkedIn(
      path.join(root, 'web'),
      'npm',
      ['test', '--', '--project', project, file],
      600000,
    ));
    const passed = passedTests(output) ?? 0;
    if (passed < 5) {
      throw new Error(file + ' did not run its suite: ' + output.slice(-2500));
    }
    total += passed;
  }
  evidence.push({
    type: 'test',
    value: 'exact SHA ' + sha + ': ' + total + ' clipboard unit/integration tests passed, ' +
      'including replay provenance, observer refusal and stale-epoch refusal',
  });
  return 'Writer provenance and controller authority keep replayed/observer/stale effects out';
});
