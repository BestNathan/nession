'use strict';
// #2581 SC-06: fixed columns; width-only font fit; height-only rows; no
// redundant local mutation for an unchanged grid.
const { run, targetSha } = require('../../../shared/control-mode-cases.cjs');
const { webTests, requireText } = require('../../../shared/terminal-engine-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();

  const geometry = webTests([
    'src/platform/terminal-runtime/view/__tests__/unit/TerminalGeometry.test.ts',
  ]);
  const writer = webTests([
    'src/platform/terminal-runtime/controller/__tests__/unit/SerializedTerminalWriter.test.ts',
  ], { filter: 'resize' });
  const controller = webTests([
    'src/platform/terminal-runtime/controller/__tests__/integration/TerminalController.test.ts',
  ], { filter: 'resize' });

  if (geometry.passed < 3) { throw new Error('expected the geometry cases, got ' + geometry.passed); }
  if (writer.passed < 4) { throw new Error('expected the resize FIFO/dedupe cases, got ' + writer.passed); }
  if (controller.passed < 4) { throw new Error('expected the controller resize cases, got ' + controller.passed); }

  requireText('web/src/platform/terminal-runtime/view/TerminalGeometry.ts', [
    'fittedWidth', 'this.fittedWidth !== width', 'publishViewportResize', 'cancelPending',
  ]);
  requireText('web/src/platform/terminal-runtime/controller/SerializedTerminalWriter.ts', [
    'lastResize', 'this.lastResize?.cols !== item.cols',
  ]);

  evidence.push(
    { type: 'runtime', value: 'exact SHA ' + sha + ': a height-only observation reuses the measured cell and recomputes rows; a width change refits the font; unchanged geometry reports and mutates nothing' },
    { type: 'stream', value: 'the ordered writer keeps a deduped resize in FIFO position, so its parser-completed callback cannot overtake an earlier write' },
  );
  return 'Session columns stay fixed across viewport/font/lease changes; height-only events do not refit the width, and an unchanged grid generates no redundant local mutation or remote resize';
});
