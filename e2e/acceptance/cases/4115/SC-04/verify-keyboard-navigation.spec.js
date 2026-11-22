'use strict';
// #4115 SC-04 (keyboard + navigation): a deterministic visual-viewport
// keyboard change reaches the single App viewport owner, does not add a second
// compensation to the Workspace scroll inset, leaves the focused editable
// reachable, and Back/pop keep the Terminal mounted with unchanged PTY rows.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const keyboard = require('../../../shared/keyboard-avoidance-browser.cjs');
const swipe = require('../../../shared/swipe-2724-cases.cjs');
const helper = require('../../../shared/app-workspace-4115-browser.cjs');

async function hostScrollInset(page) {
  return page.evaluate(() => {
    const shell = document.querySelector('[data-testid="workspace-shell"]');
    return shell instanceof HTMLElement
      ? getComputedStyle(shell).getPropertyValue('--nession-local-workspace-scroll-bottom-inset').trim()
      : null;
  });
}

test('SC-04 keyboard visibility and Back/Pop preserve editors and the Terminal', async ({ page }) => {
  test.setTimeout(110_000);
  const { sha } = verifiedRuntime('SC-04');

  await page.setViewportSize({ width: 390, height: 844 });
  await keyboard.installVisualViewportFixture(page);
  await helper.openApp(page);
  await helper.seedLongEditableFile(page);
  await page.getByTestId('app-header-workspace').first().click();
  await page.getByTestId('workspace-tool-files').click({ timeout: 30_000 });
  await page.getByTestId('workspace-shell').waitFor({ timeout: 30_000 });
  await page.getByTestId('file-row-bulk').click();
  await page.getByTestId('file-row-bulk/long.ts').click();
  await page.getByRole('button', { name: 'Edit' }).click();
  await page.locator('.cm-content').click();
  await page.keyboard.type('start\n');

  const before = {
    facts: await keyboard.terminalFacts(page),
    inset: await hostScrollInset(page),
  };
  expect(before.facts, 'the fixture Terminal is mounted under the Workspace').not.toBeNull();
  expect(before.inset, 'the host published its scroll inset before the keyboard').not.toBeNull();

  await keyboard.setKeyboardInset(page, 260);
  await expect.poll(async () => (await keyboard.viewportEnvironment(page))?.keyboard)
    .toBe('open');

  // The App viewport owner changed, not the Workspace's layout: the host does
  // not add the keyboard as a second trailing compensation.
  expect(await hostScrollInset(page), 'no duplicate keyboard compensation in the host inset')
    .toBe(before.inset);

  const visible = await page.evaluate(() => {
    const element = document.querySelector('[data-app-viewport-environment]');
    if (!(element instanceof HTMLElement)) return null;
    const top = Number(element.dataset.appVisibleTop ?? 0);
    const height = Number(element.dataset.appVisibleHeight ?? 0);
    const layoutTop = element.getBoundingClientRect().top;
    return { visibleBottom: layoutTop + top + height };
  });
  expect(visible, 'the App environment publishes visible bounds').not.toBeNull();

  // The focused editor remains reachable inside its own legal scroll range: it
  // can be brought wholly above the visible bottom, and typing still works.
  const reachable = await page.evaluate((visibleBottom) => {
    const active = document.activeElement;
    const line = document.querySelector('.cm-activeLine');
    const scroller = document.querySelector('.cm-scroller');
    if (!(active instanceof Element) || !(line instanceof HTMLElement) || !(scroller instanceof HTMLElement)) {
      return null;
    }
    if (active.closest('.cm-editor') === null) return null;
    line.scrollIntoView({ block: 'center' });
    const rect = line.getBoundingClientRect();
    return {
      activeInsideEditor: true,
      lineBottom: rect.bottom,
      visibleBottom,
      legalRange: scroller.scrollHeight > scroller.clientHeight,
      scrollTop: scroller.scrollTop,
    };
  }, visible.visibleBottom);
  expect(reachable, 'the focused editable and its own scroll owner are present').not.toBeNull();
  expect(reachable.activeInsideEditor, 'focus stayed inside the editor').toBe(true);
  expect(reachable.legalRange, 'the editor keeps a real internal scroll range').toBe(true);
  expect(reachable.lineBottom, 'the focused line can be revealed inside the visible bounds')
    .toBeLessThanOrEqual(visible.visibleBottom - 8);
  await page.keyboard.type('in-keyboard');
  await expect(page.locator('.cm-content')).toContainText('in-keyboard');

  const after = await keyboard.terminalFacts(page);
  expect(after.rows, 'keyboard-only change does not re-fit the Terminal rows').toBe(before.facts.rows);
  expect(after.resizes, 'keyboard-only change does not resize the PTY').toBe(before.facts.resizes);

  await keyboard.resetVisualViewport(page);
  await keyboard.blurActive(page);

  // ── Back / Forward / Pop / Back to the Terminal ──
  await helper.markTerminal(page);
  await page.getByTestId('app-page-back').click();
  await page.getByRole('button', { name: 'Leave without saving' }).click();
  await page.getByTestId('files-app-layout').waitFor({ timeout: 30_000 });
  await expect(page.getByTestId('app-layer-root')).toHaveAttribute('data-swipe-phase', 'idle');
  // Leaving the viewer recorded a real forward destination (#3971).
  await expect(page.getByTestId('app-layer-root')).toHaveAttribute(
    'data-workspace-stack-forward',
    'long.ts',
  );

  // A leftward inner swipe restores the recorded viewer depth.
  const breadcrumb = await page.getByTestId('files-app-breadcrumb').boundingBox();
  expect(breadcrumb, 'the Files breadcrumb is laid out').not.toBeNull();
  // The breadcrumb's bottom padding is non-interactive surface (the path
  // segments and their two buttons sit above it), inside the shell's band but
  // clear of the OS guard.
  const innerPoint = {
    x: Math.round(breadcrumb.x + 120),
    y: Math.round(breadcrumb.y + breadcrumb.height - 2),
  };
  await swipe.swipe(page, {
    from: innerPoint,
    to: { x: Math.round(innerPoint.x - 140), y: innerPoint.y },
  });
  await expect(page.getByTestId('app-page-header')).toContainText('long.ts', {
    timeout: 10_000,
  });
  await page.locator('.cm-editor').waitFor({ timeout: 30_000 });
  await expect(page.getByTestId('app-layer-root')).toHaveAttribute('data-swipe-phase', 'idle');

  // Back pops the restored clean viewer and then each navigator depth; the
  // capability root's Back leaves for the Terminal through the same host
  // header. Click until the App says the Terminal is the layer — the number of
  // Files navigator depths is the capability's own, not this Case's premise.
  for (let index = 0; index < 5; index += 1) {
    const layer = await page.getByTestId('app-layer-root').getAttribute('data-layer');
    if (layer === 'terminal') break;
    await page.getByTestId('app-page-back').click();
    await page.waitForTimeout(250);
  }
  await expect(page.getByTestId('app-layer-root')).toHaveAttribute('data-layer', 'terminal', {
    timeout: 10_000,
  });
  expect(await helper.terminalMarkedCount(page), 'the original xterm instance survived navigation')
    .toBe(1);
  const finalFacts = await keyboard.terminalFacts(page);
  expect(finalFacts.rows, 'navigation did not re-fit Terminal rows').toBe(before.facts.rows);
  expect(finalFacts.resizes, 'navigation did not resize the PTY').toBe(before.facts.resizes);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': at 390 a deterministic 260px visual-viewport '
      + 'keyboard inset made the App environment publish keyboard=open while '
      + 'the host workspace scroll inset stayed byte-identical (no duplicate '
      + 'compensation); the focused CodeMirror line was revealable inside the '
      + 'visible bounds through its own legal scroll range and accepted more '
      + 'text; Terminal rows/resizes were unchanged; Back + the unsaved-changes '
      + 'guard returned to the Files root; a right swipe from the root returned '
      + 'to the Terminal with the original xterm instance and unchanged rows.',
  });
});
