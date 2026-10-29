'use strict';
// #2598 SC-02: native text selection/paste keep their semantics — a paste is
// bracketed exactly as the terminal's mode says, and a real Session executes
// the pasted command once. IME/remount/reconnect ownership is proven by the
// runtime half on the same SHA.
const { test, expect } = require('@playwright/test');
const {
  verifiedRuntime, openClipboardFixture, emit, sentFrames,
} = require('../../../shared/terminal-clipboard-cases.cjs');
const {
  createAndAttach, command, countInBuffer,
} = require('../../../shared/foreground-resume-browser.cjs');

/** Dispatch a real paste event with the given text on the visible terminal. */
async function dispatchTextPaste(page, text) {
  return page.evaluate((value) => {
    const visible = Array.from(document.querySelectorAll('.xterm')).find((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    const target = visible?.querySelector('.xterm-helper-textarea');
    if (!target) { throw new Error('no visible terminal paste target'); }
    target.focus();
    const data = new DataTransfer();
    data.setData('text/plain', value);
    const event = new ClipboardEvent('paste', {
      clipboardData: data, bubbles: true, cancelable: true,
    });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  }, text);
}

test('SC-02: normal and bracketed text paste stay exact-once in fixture and live Session', async ({ page }) => {
  test.setTimeout(240_000);
  const { sha, runtime } = verifiedRuntime('SC-02');

  // Fixture: the production controller/xterm path wraps a paste with the
  // bracketed-paste mode the application set, and sends it once.
  await openClipboardFixture(page);
  await emit(page, '\x1b[?2004h');
  await page.waitForTimeout(150);
  await page.evaluate(() => { window.clipboardHarness.sent.length = 0; });
  expect(await dispatchTextPaste(page, 'bracketed value')).toBe(false);
  await expect.poll(async () => sentFrames(page), { timeout: 5_000 })
    .toEqual(['\x1b[200~bracketed value\x1b[201~']);

  // Normal mode: the same paste carries no wrapping bytes.
  await emit(page, '\x1b[?2004l');
  await page.waitForTimeout(150);
  await page.evaluate(() => { window.clipboardHarness.sent.length = 0; });
  expect(await dispatchTextPaste(page, 'normal value')).toBe(false);
  await expect.poll(async () => sentFrames(page), { timeout: 5_000 })
    .toEqual(['normal value']);

  // Live Session over the real Relay transport: the pasted value is delivered
  // once and executes once.
  // No prompt-pattern wait: the shell prompt belongs to the runtime, and the
  // GOT marker below proves both liveness and exact-once delivery.
  await createAndAttach(page, expect, runtime, 'clipboard-paste', 'Relay', null);
  const marker = 'clipboard-paste-marker-' + Date.now();
  await command(page, 'IFS= read -r pasted; printf "GOT:%s\\n" "$pasted"');
  await page.waitForTimeout(500);
  await dispatchTextPaste(page, marker);
  await page.keyboard.press('Enter');
  await expect.poll(async () => countInBuffer(page, 'GOT:' + marker), { timeout: 30_000 }).toBe(1);

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': fixture paste bytes were [200~bracketed value[201~] in ' +
      'bracketed mode and [normal value] in normal mode; live Relay Session executed the pasted ' +
      'value exactly once (GOT:' + marker + ' appeared once)',
  });
});
