'use strict';
// #2598 SC-10: the clipboard states stay minimal and truthful, do not steal
// Terminal focus/IME or touch ownership, and create no permanent toolbar. Since
// #2658 they are also never mounted automatically: the Capsule action announces
// availability, and the sentence/action exist only in the opt-in disclosure.
// The scoped interactive prototype linked from the Requirement covers the
// visual states; this Case proves the shipped surface's behavior on Web and a
// narrow App-width viewport.
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
  await expect(page.getByTestId('terminal-notices-trigger')).toHaveCount(0);
  expect(await page.getByRole('button', { name: /paste|upload/i }).count()).toBe(0);

  // Unsupported image paste: the terminal keeps focus, no content is mounted,
  // and the Capsule action announces that something is available.
  const textarea = page.locator('.xterm-helper-textarea');
  await textarea.focus();
  await dispatchPaste(page, { images: [{ mime: 'image/png', bytes: Buffer.from([1, 2, 3]) }] });
  const trigger = page.getByTestId('terminal-notices-trigger');
  await expect(trigger).toBeVisible();
  await expect(page.getByTestId('terminal-clipboard-notice')).toHaveCount(0);
  expect(await page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea')))
    .toBe(true);
  expect(await page.getByTestId('terminal-surface').getAttribute('data-terminal-notices'))
    .toContain('clipboard');

  // The exact sentence and no action are one explicit gesture away.
  await trigger.click();
  const notice = page.getByTestId('terminal-clipboard-notice');
  await expect(notice).toHaveAttribute('data-clipboard-notice', 'unsupported-image-paste');
  await expect(notice).toContainText('Image clipboard protocol not supported by this TUI');
  expect(await page.getByRole('button', { name: 'Copy' }).count()).toBe(0);
  await page.keyboard.press('Escape');

  // The notice expires on its own (transient, not a permanent state).
  await expect(trigger).toHaveCount(0, { timeout: 8_000 });

  // Narrow App-width viewport: the same truthful state, no focus loss.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  await textarea.focus();
  await dispatchPaste(page, { images: [{ mime: 'image/png', bytes: Buffer.from([9]) }] });
  await expect(trigger).toBeVisible();
  expect(await page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea')))
    .toBe(true);
  await trigger.click();
  await expect(notice).toHaveAttribute('data-clipboard-notice', 'unsupported-image-paste');
  await page.keyboard.press('Escape');
  await expect(trigger).toHaveCount(0, { timeout: 8_000 });

  // A blocked copy's user gesture is the only extra control, and it goes away.
  await page.evaluate(() => {
    const clipboard = navigator.clipboard;
    const original = clipboard.writeText.bind(clipboard);
    window.__restoreWriteText = () => { clipboard.writeText = original; };
    clipboard.writeText = async () => { throw new DOMException('denied', 'NotAllowedError'); };
  });
  // Give the terminal focus first: the claim is that the arriving notice does
  // not take it, not that a prior dialog may have left focus on the body.
  await textarea.focus();
  await page.evaluate((payload) => {
    window.clipboardHarness.emit('\x1b]52;c;' + payload + '\x1b\\');
  }, b64('scoped copy'));
  await expect(trigger).toBeVisible();
  expect(await page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea')))
    .toBe(true);
  await trigger.click();
  await expect(notice).toHaveAttribute('data-clipboard-notice', 'copy-required');
  await expect(page.getByRole('button', { name: 'Copy' })).toBeVisible();
  // Closing the (unused) disclosure restarts the short unopened window; the
  // action still expires rather than becoming permanent.
  await page.keyboard.press('Escape');
  await expect(trigger).toHaveCount(0, { timeout: 15_000 });

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': no clipboard controls and no status action existed at ' +
      'rest; the unsupported-image paste announced availability through the Capsule action, ' +
      'kept terminal focus, mounted no sentence until the explicit gesture, showed the exact ' +
      'sentence, and expired at both 1280 and 390 CSS px; the blocked-copy state offered only ' +
      'the Copy gesture inside the disclosure and expired. Scoped prototype pinned at ' +
      'https://github.com/BestNathan/nession/blob/16086ca7a78e749771eee58c8efabcfc73d30b4b/' +
      'terminal-clipboard-2598/index.html (mock states and fidelity table linked from the Issue)',
  });
});
