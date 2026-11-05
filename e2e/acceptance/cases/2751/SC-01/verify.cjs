'use strict';
// #2751 SC-01: the file identity is source-scoped and an absent provider is
// explicitly unavailable, with no silent Agent-host fallback.
const path = require('node:path');
const { run, targetSha } = require('../../../shared/control-mode-cases.cjs');
const {
  root,
  checkedIn,
  passedTests,
} = require('../../../shared/terminal-sizing-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const output = checkedIn(
    path.join(root, 'web'),
    'npm',
    [
      'test',
      '--',
      '--project',
      'unit',
      'src/capabilities/files/model/__tests__/unit/fileRef.test.ts',
    ],
    600_000,
  );
  const passed = passedTests(output) ?? 0;
  if (passed < 4) {
    throw new Error('file identity suite did not run: ' + output.slice(-2500));
  }
  evidence.push({
    type: 'test',
    value:
      'exact SHA ' + sha + ': ' + passed + ' file-identity tests passed — Session-first/' +
      'Agent-fallback source ids, absent provider explicitly unavailable with null fileOps and ' +
      'no fallback, source-scoped refs with normalized separators, and a ref from another source ' +
      'never matching the current one',
  });
  return 'FileRef identity is scoped to its source and unavailable providers fail explicitly';
});
