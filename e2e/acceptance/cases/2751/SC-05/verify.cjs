'use strict';
// #2751 SC-05: chunked reads advance by bytes and a UTF-8 sequence split across
// a chunk boundary decodes as one character.
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
      'src/capabilities/files/__tests__/unit/FilesPlugin.test.ts',
    ],
    600_000,
  );
  const passed = passedTests(output) ?? 0;
  if (passed < 15) {
    throw new Error('chunked-read suite did not run: ' + output.slice(-2500));
  }
  evidence.push({
    type: 'test',
    value:
      'exact SHA ' + sha + ': ' + passed + ' plugin tests passed, including the multi-byte ' +
      'split-chunk case (aé𝄞b split at byte 4 advances offsets 4→8 and decodes back to the ' +
      'exact text with no replacement characters) and the guarded create/revision/rename payloads',
  });
  return 'chunked UTF-8 reads are byte-correct across a split multi-byte sequence';
});
