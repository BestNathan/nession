'use strict';
// #2751 SC-06: the Web/App flows, filename validation, source-unavailable and
// conflict states have component/integration tests, and the canonical docs and
// user-facing action labels match the shipped semantics.
const fs = require('node:fs');
const path = require('node:path');
const { run, targetSha } = require('../../../shared/control-mode-cases.cjs');
const {
  root,
  checkedIn,
  passedTests,
} = require('../../../shared/terminal-sizing-cases.cjs');

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

run(({ evidence }) => {
  const sha = targetSha();

  const unitOutput = checkedIn(
    path.join(root, 'web'),
    'npm',
    [
      'test',
      '--',
      '--project',
      'unit',
      'src/capabilities/files/model/__tests__/unit/createTarget.test.ts',
      'src/capabilities/files/model/__tests__/unit/fileRef.test.ts',
    ],
    600_000,
  );
  const unitPassed = passedTests(unitOutput) ?? 0;
  if (unitPassed < 8) {
    throw new Error('context/identity unit suite did not run: ' + unitOutput.slice(-2500));
  }

  const integrationOutput = checkedIn(
    path.join(root, 'web'),
    'npm',
    [
      'test',
      '--',
      '--project',
      'integration',
      'src/capabilities/files/components/__tests__/integration/FileBrowser.test.tsx',
      'src/capabilities/files/components/__tests__/integration/FileViewer.test.tsx',
      'src/app/experiences/app/__tests__/integration/AppFilesFolderSheet.test.tsx',
      'src/app/__tests__/integration/FilesWebLayout.test.tsx',
    ],
    900_000,
  );
  const integrationPassed = passedTests(integrationOutput) ?? 0;
  if (integrationPassed < 12) {
    throw new Error('Files component suite did not run: ' + integrationOutput.slice(-2500));
  }

  const pattern = read('docs/design/design-system/patterns/file-workspace.md');
  for (const heading of [
    '### File identity and the source boundary (#2751)',
    '### Operation context (#2751)',
    '### Safe mutations (#2751)',
    '### Byte/text boundary',
  ]) {
    if (!pattern.includes(heading)) {
      throw new Error('FileWorkspace pattern is missing the converged contract heading: ' + heading);
    }
  }

  const appSheet = read('web/src/app/experiences/app/AppFilesFolderSheet.tsx');
  for (const label of ['New file', 'New folder']) {
    if (!appSheet.includes(label)) throw new Error('App folder actions are missing ' + label);
  }
  const explorerMenu = read('web/src/platform/explorer/commands/coreContributions.tsx');
  if (!explorerMenu.includes('Copy path')) {
    throw new Error('the explorer path action does not say "Copy path"');
  }

  evidence.push({
    type: 'test',
    value:
      'exact SHA ' + sha + ': ' + unitPassed + ' context/identity unit tests and ' +
      integrationPassed + ' Files component/integration tests passed (FileBrowser create ' +
      'destinations and duplicate handling, FileViewer conflict reload/overwrite, App folder ' +
      'creation, source-unavailable rendering); file-workspace.md carries the #2751 identity, ' +
      'operation-context, safe-mutation and byte-boundary sections; App actions say New file/' +
      'New folder and the explorer path action says Copy path',
  });
  return 'Files flows, source/conflict states, docs and action labels are covered and truthful';
});
