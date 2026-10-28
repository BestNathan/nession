'use strict';
// #2581 SC-10: fixture/production construction parity and the durable
// architecture/knowledge decision.
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { run, targetSha } = require('../../../shared/control-mode-cases.cjs');
const {
  root, webTests, nodeTests, requireText,
} = require('../../../shared/terminal-engine-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();

  requireText('web/src/app/fixture/FixtureTerminal.tsx', [
    'createTerminalEmulator', "from '@/platform/terminal-runtime/xterm'", "rendererType: 'dom'",
  ], ['@xterm/']);
  requireText('web/src/product/terminal/components/TerminalViewport.tsx', [], ['@xterm/']);
  requireText('docs/architecture/terminal-engine.md', [
    'Current writable owners', 'Final dependency graph', 'Machine-checked boundary',
    'Tests',
  ]);

  // The visual-vocabulary contract moved to the geometry owner when the
  // production setter moved; keep that registration executable.
  const vocabulary = spawnSync('node', ['design/scripts/visual-vocabulary-source.mjs'], {
    cwd: root, encoding: 'utf8', timeout: 120000,
    env: { ...process.env, GH_TOKEN: '', GITHUB_TOKEN: '' },
  });
  if (vocabulary.status !== 0) {
    throw new Error('the visual-vocabulary source contract failed: ' +
      String(vocabulary.stdout || '') + String(vocabulary.stderr || ''));
  }

  const emulator = webTests([
    'src/platform/terminal-runtime/xterm/__tests__/integration/XtermEmulator.test.ts',
  ]);
  const metrics = webTests([
    'src/platform/terminal-runtime/xterm/__tests__/unit/XtermMetrics.test.ts',
  ]);
  if (emulator.passed < 1 || metrics.passed < 6) {
    throw new Error('the shared emulator/metrics rules did not run');
  }

  evidence.push(
    { type: 'runtime', value: 'exact SHA ' + sha + ': the canonical fixture constructs through the public engine barrel and shares the renderer/theme/metrics rules; no app/product file imports @xterm' },
    { type: 'docs', value: 'docs/architecture/terminal-engine.md records the writable owners, final graph, machine-checked boundary and test owners; the visual-vocabulary source contract registers TerminalGeometry as the content-width producer' },
  );
  return 'Fixture and production terminal construction share the engine rules; architecture docs and the executable vocabulary contract are updated with evidence';
});
