'use strict';
// #2879 SC-03: a link registration is one stable record whose current xterm
// provider is replaced on renderer recreation. Repeated rebuilds and normal
// reattach must leave exactly one provider, one activation per gesture, and no
// provider for the retired matcher after cleanup.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const { openLifecycleFixture } = require('../../../shared/terminal-memory-lifecycle-cases.cjs');

test('SC-03: link registration follows renderer replacement and cleanup removes the latest provider', async ({ page }) => {
  test.setTimeout(240_000);
  const { sha } = verifiedRuntime('SC-03');
  await openLifecycleFixture(page);

  const observed = await page.evaluate(async () => {
    const lifecycle = window.clipboardHarness.lifecycle;
    const liveTerminal = () => {
      const visible = Array.from(document.querySelectorAll('.xterm')).find((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      return visible && visible.parentElement && visible.parentElement.xtermInstance;
    };
    const providers = () => {
      const terminal = liveTerminal();
      return terminal ? terminal._core._linkProviderService.linkProviders : [];
    };
    const findLine = (needle) => {
      const terminal = liveTerminal();
      if (!terminal) { return -1; }
      const buffer = terminal.buffer.active;
      for (let index = buffer.length - 1; index >= 0; index -= 1) {
        const text = buffer.getLine(index)?.translateToString(true) ?? '';
        if (text.includes(needle)) { return index; }
      }
      return -1;
    };
    const waitFor = async (predicate, label) => {
      const deadline = performance.now() + 20_000;
      while (performance.now() < deadline) {
        if (predicate()) { return; }
        await new Promise((resolve) => requestAnimationFrame(() => resolve()));
      }
      throw new Error('timeout: ' + label);
    };
    // xterm asks every registered provider and aggregates the replies; asking
    // them all means a duplicate registration would activate twice here too.
    const activateLine = async (lineIndex) => {
      let activated = 0;
      for (const provider of providers()) {
        activated += await new Promise((resolve) => {
          provider.provideLinks(lineIndex + 1, (links) => {
            if (!links || links.length === 0) { resolve(0); return; }
            for (const link of links) {
              link.activate(new MouseEvent('click'), link.text);
            }
            resolve(links.length);
          });
        });
      }
      return activated;
    };

    lifecycle.installLinks();
    window.clipboardHarness.emit('LINK-ORIGINAL\r\n');
    await waitFor(() => findLine('LINK-ORIGINAL') >= 0, 'original link');
    const baseline = providers().length;
    const firstGesture = await activateLine(findLine('LINK-ORIGINAL'));
    const afterFirst = lifecycle.activations();

    const rebuildCounts = [];
    for (let round = 0; round < 3; round += 1) {
      const before = lifecycle.snapshot().rendererReplacements;
      lifecycle.forceOverflow();
      await waitFor(
        () => lifecycle.snapshot().rendererReplacements >= before + 1,
        'renderer replacement ' + round,
      );
      rebuildCounts.push(providers().length);
    }

    window.clipboardHarness.emit('LINK-REBUILT\r\n');
    await waitFor(() => findLine('LINK-REBUILT') >= 0, 'rebuilt link');
    const rebuiltGesture = await activateLine(findLine('LINK-REBUILT'));
    const afterRebuild = lifecycle.activations();

    lifecycle.detach();
    lifecycle.attachNewHost();
    window.clipboardHarness.emit('LINK-REATTACHED\r\n');
    await waitFor(() => findLine('LINK-REATTACHED') >= 0, 'reattached link');
    const reattachedProviders = providers().length;
    const reattachedGesture = await activateLine(findLine('LINK-REATTACHED'));
    const afterReattach = lifecycle.activations();

    lifecycle.disposeLinks();
    const afterDispose = providers().length;
    return {
      baseline,
      firstGesture,
      afterFirst,
      rebuildCounts,
      rebuiltGesture,
      afterRebuild,
      reattachedProviders,
      reattachedGesture,
      afterReattach,
      afterDispose,
    };
  });

  // One built-in OSC 8 provider plus the one matcher registration.
  expect(observed.baseline).toBe(2);
  expect(observed.firstGesture).toBe(1);
  expect(observed.afterFirst).toBe(1);
  expect(observed.rebuildCounts).toEqual([2, 2, 2]);
  expect(observed.rebuiltGesture).toBe(1);
  expect(observed.afterRebuild).toBe(2);
  expect(observed.reattachedProviders).toBe(2);
  expect(observed.reattachedGesture).toBe(1);
  expect(observed.afterReattach).toBe(3);
  // Cleanup removes the latest provider, leaving only the engine's own.
  expect(observed.afterDispose).toBe(1);

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': baseline provider count 2 (OSC + matcher); ' +
      'three real writer-overflow rebuilds each kept 2 providers; one activation per gesture ' +
      'before/after rebuild/after reattach (1,2,3 cumulative); disposing the public ' +
      'registration left 1 provider on the live emulator',
  });
});
