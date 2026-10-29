'use strict';
// #2598 SC-08 (runtime half): there is no application-specific clipboard
// adapter and no image-to-path conversion anywhere in the product paste path.
const path = require('node:path');
const fs = require('node:fs');
const { run, targetSha } = require('../../../shared/control-mode-cases.cjs');

const FORBIDDEN = ['claude', 'codex', 'tmp/', 'path.join', 'image.png', 'attachment'];

run(({ evidence }) => {
  const sha = targetSha();
  const root = path.join(__dirname, '../../../../..');
  const files = [
    'web/src/platform/terminal-runtime/clipboard/ClipboardProtocol.ts',
    'web/src/platform/terminal-runtime/clipboard/browserClipboard.ts',
    'web/src/platform/terminal-runtime/controller/TerminalController.ts',
  ];
  for (const file of files) {
    const source = fs.readFileSync(path.join(root, file), 'utf8').toLowerCase();
    for (const needle of FORBIDDEN) {
      if (source.includes(needle.toLowerCase())) {
        throw new Error(file + ' contains application-specific/file-path token ' + needle);
      }
    }
  }
  const protocol = fs.readFileSync(
    path.join(root, 'web/src/platform/terminal-runtime/clipboard/ClipboardProtocol.ts'),
    'utf8',
  );
  if (!protocol.includes('unsupported-image-paste')) {
    throw new Error('the protocol no longer reports the unnegotiated image paste state');
  }
  evidence.push({
    type: 'source',
    value: 'exact SHA ' + sha + ': no application-specific or file-path clipboard adapter exists ' +
      '(searched: ' + FORBIDDEN.join(', ') + '); the unnegotiated image paste is reported, not sent',
  });
  return 'No app-specific adapter or file-path conversion exists for unsupported TUIs';
});
