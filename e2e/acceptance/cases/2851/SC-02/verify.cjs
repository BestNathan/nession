'use strict';
// #2851 SC-02 runtime proof: the menu adapters reuse the existing Web owners
// (metadata editor, attach configure, typed-name kill), not a second API.
const { run, checked, targetSha } = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const result = checked(
    'npm',
    [
      '--prefix', 'web', 'test', '--',
      '--project', 'integration',
      'src/product/session/patterns/__tests__/integration/SessionItem.test.tsx',
      'src/product/session/components/__tests__/integration/SessionDetailsMetadata.test.tsx',
      'src/product/session/components/__tests__/integration/KillConfirmDialog.test.tsx',
      'src/app/__tests__/integration/AttachFlow.test.tsx',
      '--run',
    ],
    300000,
  );
  const clean = result.replace(/\x1b\[[0-9;]*m/g, '');
  if (!/Test Files\s+4 passed/.test(clean) || !/Tests\s+\d+ passed/.test(clean)) {
    throw new Error('the four-action owner tests did not pass: ' + result.slice(-4000));
  }
  evidence.push({
    type: 'test',
    value:
      'exact SHA ' + sha + ': the real Web integration suites proved the four-action row menu, the existing ' +
      'SessionDetails/SessionMetadataSection alias edit and revision ownership, the existing AttachDialog ' +
      'configure path, and KillConfirmDialog unlocking only after the exact Session name is typed',
  });
  return 'The unified row menu adapts to the existing metadata, attach and typed-name kill owners';
});
