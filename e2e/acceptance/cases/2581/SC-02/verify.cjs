'use strict';
// #2581 SC-02: the machine-checked Xterm Engine boundary.
//
// The boundary is executable in two places: the `nession/no-direct-xterm`
// rule (with its negative fixtures) and the source it actually polices. This
// Case runs the rule's own valid/invalid suite and lints the production
// Product/engine paths; it also proves the Product link surface no longer
// reads `controller.terminal`.
const { run, targetSha } = require('../../../shared/control-mode-cases.cjs');
const { nodeTests, webLint, requireText } = require('../../../shared/terminal-engine-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();

  const fixtures = nodeTests('web/eslint-plugin-nession/__tests__/no-direct-xterm.test.js');
  if (fixtures.passed < 2) {
    throw new Error('the rule fixture suite ran ' + fixtures.passed + ' tests; expected its valid and invalid cases');
  }

  webLint([
    'src/product/terminal/components/TerminalViewport.tsx',
    'src/product/terminal/workspaceFileLinks.ts',
    'src/platform/terminal-runtime/xterm',
    'src/platform/terminal-runtime/view',
  ]);

  requireText('web/eslint-plugin-nession/rules/no-direct-xterm.js', [
    'XTERM_METRICS_FILE', 'engineImport', 'rawImport', 'privateCore',
  ]);
  requireText('docs/architecture/terminal-engine.md', [
    'nession/no-direct-xterm', 'XtermMetrics.ts', 'SerializedTerminalWriter',
  ]);
  requireText('web/src/product/terminal/components/TerminalViewport.tsx', [
    'registerLinkMatcher',
  ], ['controller.terminal', '@xterm/']);

  evidence.push(
    { type: 'runtime', value: 'exact SHA ' + sha + ': the no-direct-xterm fixtures reject Product/UI @xterm imports, engine-module imports and _core access outside the single adapter' },
    { type: 'lint', value: 'production Product/engine paths pass eslint with nession/no-direct-xterm at error; TerminalViewport registers links through the controller and has no raw-terminal or @xterm reference' },
  );
  return 'One machine-checked rule rejects Product/UI xterm imports, engine-module access and private _core reads, with negative fixtures and a clean production lint';
});
