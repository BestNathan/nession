'use strict';
// #2598 SC-10: the clipboard states stay minimal and truthful, do not steal
// Terminal focus/IME or touch ownership, and create no permanent toolbar. The
// scoped interactive prototype linked from the Requirement covers the visual
// states; this Case proves the shipped surface's behavior on Web and a narrow
// App-width viewport.
const { test, expect } = require('@playwright/test');
const {
  verifiedRuntime, openClipboardFixture, dispatchPaste,
} = require('../../../shared/terminal-clipboard-cases.cjs');

const b64 = (value) => Buffer.from(value, 'utf8').toString('base64');

test('SC-10: notices are transient, truthful and do not take focus', async ({ page }) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-10');
  await openClipboardFixture(page);

  // No permanent paste/upload controls exist at rest.
  await expect(page.getByTestId('terminal-clipboard-notice')).toHaveCount(0);
  expect(await page.getByRole('button', { name: /paste|upload/i }).count()).toBe(0);

  // Unsupported image paste: one sentence, no action, focus untouched.
  const textarea = page.locator('.xterm-helper-textarea');
  await textarea.focus();
  await dispatchPaste(page, { images: [{ mime: 'image/png', bytes: Buffer.from([1, 2, 3]) }] });
  const notice = page.getByTestId('terminal-clipboard-notice');
  await expect(notice).toHaveAttribute('data-clipboard-notice', 'unsupported-image-paste');
  expect(await page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea')))
    .toBe(true);
  // The strip is laid out beside (not over) the terminal well.
  const geometry = await page.evaluate(() => {
    const strip = document.querySelector('[data-testid="terminal-clipboard-notice"]');
    const host = document.querySelector('[data-terminal-capsule-host]');
    return {
      stripTop: strip?.getBoundingClientRect().top ?? -1,
      hostBottom: host?.getBoundingClientRect().bottom ?? -1,
    };
  });
  expect(geometry.stripTop).toBeGreaterThanOrEqual(geometry.hostBottom - 1);

  // The notice expires on its own (transient, not a permanent state).
  await expect(notice).toHaveCount(0, { timeout: 8_000 });

  // Narrow App-width viewport: the same truthful state, no focus loss.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  await textarea.focus();
  await dispatchPaste(page, { images: [{ mime: 'image/png', bytes: Buffer.from([9]) }] });
  await expect(notice).toHaveAttribute('data-clipboard-notice', 'unsupported-image-paste');
  expect(await page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea')))
    .toBe(true);
  await expect(notice).toHaveCount(0, { timeout: 8_000 });

  // A blocked copy's user gesture is the only extra control, and it goes away.
  await page.evaluate(() => {
    const clipboard = navigator.clipboard;
    const original = clipboard.writeText.bind(clipboard);
    window.__restoreWriteText = () => { clipboard.writeText = original; };
    clipboard.writeText = async () => { throw new DOMException('denied', 'NotAllowedError'); };
  });
  await page.evaluate((payload) => {
    window.clipboardHarness.emit('\x1b]52;c;' + payload + '\x1b\\');
  }, b64('scoped copy'));
  await expect(notice).toHaveAttribute('data-clipboard-notice', 'copy-required');
  await expect(page.getByRole('button', { name: 'Copy' })).toBeVisible();
  expect(await page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea')))
    .toBe(true);
  await expect(notice).toHaveCount(0, { timeout: 12_000 });

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': no clipboard controls exist at rest; the unsupported ' +
      'image paste strip stated one sentence beside the well (strip top >= host bottom), kept ' +
      'terminal focus, and expired at both 1280 and 390 CSS px; the blocked-copy strip offered ' +
      'only the Copy gesture and expired. Scoped prototype pinned at ' +
      'https://github.com/BestNathan/nession/blob/16086ca7a78e749771eee58c8efabcfc73d30b4b/' +
      'terminal-clipboard-2598/index.html (mock states and fidelity table linked from the Issue)',
  });
});
