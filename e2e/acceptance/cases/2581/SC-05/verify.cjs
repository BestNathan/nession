'use strict';
// #2581 SC-05: Product Workspace Links go through the emulator port, with
// correct cell coordinates for ASCII, wide, combining and wrapped text.
const { run, targetSha } = require('../../../shared/control-mode-cases.cjs');
const { webTests, requireText } = require('../../../shared/terminal-engine-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();

  const mapping = webTests([
    'src/platform/terminal-runtime/xterm/__tests__/unit/LineLinks.test.ts',
  ]);
  const lines = webTests([
    'src/platform/terminal-runtime/xterm/__tests__/integration/XtermMetricsLines.test.ts',
  ]);
  const product = webTests([
    'src/product/terminal/__tests__/unit/workspaceFileLinks.test.ts',
  ]);

  if (mapping.passed < 6) { throw new Error('expected the offset-to-cell mapping cases, got ' + mapping.passed); }
  if (lines.passed < 4) { throw new Error('expected the logical-line cases, got ' + lines.passed); }
  if (product.passed < 5) { throw new Error('expected the product match cases, got ' + product.passed); }

  requireText('web/src/product/terminal/workspaceFileLinks.ts', [
    'workspaceFileLinkMatcher', 'startIndex', 'endIndex',
  ], ['@xterm/']);
  requireText('web/src/product/terminal/components/TerminalViewport.tsx', [
    'controller.registerLinkMatcher',
  ], ['controller.terminal', '@xterm/']);

  evidence.push(
    { type: 'runtime', value: 'exact SHA ' + sha + ': offset-to-cell mapping is correct for ASCII, wide (two-cell) characters, combining sequences, wrapped continuations, and drops out-of-range matches' },
    { type: 'product', value: 'Workspace link recognition/activation stays in Product; the viewport registers a matcher through the controller and holds no raw terminal reference' },
  );
  return 'Workspace Links are installed through the emulator port and underline the cells xterm drew for ASCII, wide, combining and wrapped text';
});
