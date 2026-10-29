'use strict';
// #2581 SC-04: renderer failure fallback and stale-callback isolation.
//
// jsdom has no GPU context, so the renderer exposes failure-injection seams
// (a fake WebGL addon) and the test fires a context loss deterministically.
const { run, targetSha } = require('../../../shared/control-mode-cases.cjs');
const { webTests, requireText } = require('../../../shared/terminal-engine-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();

  const fallback = webTests([
    'src/platform/terminal-runtime/xterm/__tests__/integration/XtermRenderer.test.ts',
  ], { filter: 'falls back to Canvas' });
  if (fallback.passed < 1) { throw new Error('the context-loss fallback test did not run'); }

  requireText('web/src/platform/terminal-runtime/xterm/XtermRenderer.ts', [
    'fallbackToCanvas', 'onContextLoss', 'if (this.disposed) { return; }', 'createCanvas',
  ]);
  requireText('web/src/platform/terminal-runtime/xterm/XtermAddonHost.ts', [
    'dispose(type:', 'disposeTracking',
  ]);

  evidence.push(
    { type: 'runtime', value: 'exact SHA ' + sha + ': an injected WebGL context loss disposes the WebGL addon and installs Canvas on the same terminal; a loss delivered after dispose is ignored' },
    { type: 'failure-injection', value: 'the renderer test supplies a fake WebGL addon through RendererHooks and drives the real fallback path deterministically' },
  );
  return 'WebGL initialization, context-loss fallback and addon disposal keep a usable terminal, and stale renderer callbacks cannot act after teardown';
});
