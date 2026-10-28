'use strict';
// #2581 SC-03: one emulator survives detach/reparent/StrictMode with exactly
// one set of subscriptions, and disposal releases the emulator once.
const { run, targetSha } = require('../../../shared/control-mode-cases.cjs');
const { webTests, requireText } = require('../../../shared/terminal-engine-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();

  const lifecycle = webTests([
    'src/platform/terminal-runtime/xterm/__tests__/integration/XtermEmulator.test.ts',
  ]);
  const attachCycles = webTests([
    'src/platform/terminal-runtime/controller/__tests__/integration/TerminalController.test.ts',
  ], { filter: 'attach' });
  const strictMode = webTests([
    'src/product/terminal/components/__tests__/integration/TerminalViewport.test.tsx',
  ], { filter: 'StrictMode' });

  if (lifecycle.passed < 1) { throw new Error('the emulator lifecycle suite did not run'); }
  if (attachCycles.passed < 3) {
    throw new Error('expected the detach/re-attach/reparent cycle tests, got ' + attachCycles.passed);
  }
  if (strictMode.passed < 1) { throw new Error('the StrictMode viewport test did not run'); }

  requireText('web/src/platform/terminal-runtime/xterm/XtermEmulator.ts', [
    'mount(host: HTMLElement)', 'unmount(): void', 'dispose(): void', 'this.terminal.dispose()',
  ]);

  evidence.push(
    { type: 'runtime', value: 'exact SHA ' + sha + ': one emulator keeps its buffer across detach/reparent; five attach/detach cycles and StrictMode replay produce one keystroke per key, not one per leaked subscription' },
    { type: 'lifecycle', value: 'the emulator installs mount/unmount/dispose on one terminal and disposes that terminal exactly once; no second instance is constructed during attach/detach' },
  );
  return 'One emulator instance survives viewport detach, reparenting and React StrictMode replay without duplicate input/listener subscriptions, and disposal releases it once';
});
