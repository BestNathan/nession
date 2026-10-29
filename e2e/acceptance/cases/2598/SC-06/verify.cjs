'use strict';
// #2598 SC-06 (runtime half): the source proves the image path is protocol-only
// — no Files capability, upload endpoint or remote path is imported by the
// clipboard/paste owners.
const path = require('node:path');
const fs = require('node:fs');
const { run, targetSha } = require('../../../shared/control-mode-cases.cjs');

const FORBIDDEN = [
  'agent.file.write',
  'FilesPlugin',
  'file.write',
  'upload',
  'createObjectURL',
];

run(({ evidence }) => {
  const sha = targetSha();
  const root = path.join(__dirname, '../../../../..');
  const owners = [
    'web/src/platform/terminal-runtime/clipboard/ClipboardProtocol.ts',
    'web/src/platform/terminal-runtime/clipboard/browserClipboard.ts',
    'web/src/platform/terminal-runtime/controller/TerminalController.ts',
  ];
  for (const file of owners) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    for (const needle of FORBIDDEN) {
      if (source.includes(needle)) {
        throw new Error(file + ' references forbidden upload/file path ' + needle);
      }
    }
  }
  const protocol = fs.readFileSync(
    path.join(root, 'web/src/platform/terminal-runtime/clipboard/ClipboardProtocol.ts'),
    'utf8',
  );
  if (!protocol.includes('writeClipboard') || !protocol.includes('userPasted')) {
    throw new Error('the protocol owner no longer owns the MIME clipboard path');
  }
  evidence.push({
    type: 'source',
    value: 'exact SHA ' + sha + ': the clipboard protocol, browser adapter and controller contain ' +
      'no Files/upload/path adapter (searched: ' + FORBIDDEN.join(', ') + ')',
  });
  return 'Image clipboard data has no upload or file-path path in source';
});
