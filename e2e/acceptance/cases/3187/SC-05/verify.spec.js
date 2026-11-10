'use strict';
// #3187 SC-05: Terminal → Files navigation preserves the same PTY/Session,
// buffer and scroll position; plain text, selection and App taps are not
// captured by file links.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const {
  activateReference,
  markTerminal,
  openAppShell,
  openShell,
  printReference,
  readTerminalState,
  referencePoint,
  returnToTerminal,
  runLine,
  scrollTerminal,
  seedTerminalFiles,
} = require('../../../shared/terminal-file-links.cjs');

test.setTimeout(110_000);

test('SC-05 Web: click, selection and scroll keep the same Terminal', async ({ browser }) => {
  const { runtime, sha } = verifiedRuntime('SC-05');
  seedTerminalFiles(runtime.home);
  const context = await browser.newContext({ viewport: { width: 1180, height: 900 } });
  const page = await context.newPage();
  try {
    await openShell(page, expect, runtime, 'sc05-web');
    await runLine(page, expect, 'seq 1 60');
    await printReference(page, expect, 'NOT_A_FILE_MARKER');
    for (let index = 0; index < 10; index += 1) {
      await printReference(page, expect, 'plain.py:5');
    }
    await markTerminal(page);
    const base = await readTerminalState(page);
    expect(base.xtermCount).toBe(1);
    expect(base.instanceMarker).toBe('original');

    // Plain text is not a link. The Files pane stays mounted (hidden) behind
    // the Terminal, so "did not navigate" is about the active surface.
    await activateReference(page, 'NOT_A_FILE_MARKER');
    await expect(page.getByTestId('file-workspace')).toBeHidden();
    await expect(page.getByTestId('terminal-surface')).toBeVisible();

    // A selection drag that crosses a valid reference selects text, it does
    // not open: the press starts on ordinary text, not on the link.
    const start = await referencePoint(page, 'printf');
    const link = await referencePoint(page, 'plain.py:5');
    await page.mouse.click(start.x, start.y);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(link.x + 20, link.y, { steps: 8 });
    await page.mouse.up();
    const selection = await page.evaluate(() => {
      const xterm = Array.from(document.querySelectorAll('.xterm')).find((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      return xterm?.parentElement?.xtermInstance?.getSelection?.() ?? '';
    });
    expect(selection.length).toBeGreaterThan(0);
    await expect(page.getByTestId('file-workspace')).toBeHidden();
    await page.evaluate(() => {
      const xterm = Array.from(document.querySelectorAll('.xterm')).find((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      xterm?.parentElement?.xtermInstance?.clearSelection?.();
    });

    // Scroll away from the bottom, then navigate from the scrolled viewport.
    await scrollTerminal(page, -120);
    await expect.poll(async () => (await readTerminalState(page)).viewportY, { timeout: 10_000 })
      .toBeLessThan(base.viewportY);
    const scrolled = await readTerminalState(page);
    expect(scrolled.viewportY).toBeLessThan(base.viewportY);
    await referencePoint(page, 'plain.py:5');

    await activateReference(page, 'plain.py:5');
    await expect(page.getByTestId('file-workspace')).toBeVisible();
    await returnToTerminal(page, expect, 'web');

    const after = await readTerminalState(page);
    expect(after.xtermCount, 'exactly one Terminal remains').toBe(1);
    expect(after.instanceMarker, 'the same xterm node remains').toBe('original');
    expect(after.viewportY, 'the scrolled position is unchanged').toBe(scrolled.viewportY);
    expect(after.text, 'the buffer is unchanged').toBe(scrolled.text);

    test.info().annotations.push({
      type: 'evidence',
      description:
        'exact SHA ' + sha + ': Web 1180 plain text and a text-selection drag opened no Files; ' +
        'after navigating from a scrolled (viewportY ' + scrolled.viewportY + ' vs bottom ' +
        base.viewportY + ') Terminal the original xterm, buffer and scroll position were unchanged',
    });
  } finally {
    await context.close();
  }
});

test('SC-05 App: a plain tap stays in the Terminal', async ({ browser }) => {
  const { runtime, sha } = verifiedRuntime('SC-05');
  seedTerminalFiles(runtime.home);
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  try {
    await openAppShell(page, expect, runtime, 'sc05-app');
    await printReference(page, expect, 'NOT_A_FILE_MARKER');
    await markTerminal(page);
    await activateReference(page, 'NOT_A_FILE_MARKER', { touch: true });
    await expect(page.getByTestId('app-page-header')).toHaveCount(0);
    const state = await readTerminalState(page);
    expect(state.xtermCount).toBe(1);
    expect(state.instanceMarker).toBe('original');
    test.info().annotations.push({
      type: 'evidence',
      description:
        'exact SHA ' + sha + ': App 390x844 tapped plain terminal text; no Files depth opened ' +
        'and the single original xterm stayed mounted',
    });
  } finally {
    await context.close();
  }
});
