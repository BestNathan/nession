'use strict';
// #2598 SC-09: two real clients on one Session (P2P and Relay). Clipboard
// effects and protocol replies belong to the authorized Controller, not to an
// observer and not to whichever client merely attached last.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/terminal-clipboard-cases.cjs');
const {
  createAndAttach, attachExisting, command,
} = require('../../../shared/foreground-resume-browser.cjs');

const b64 = (value) => Buffer.from(value, 'utf8').toString('base64');

/** Record clipboard.writeText calls in one page without losing the real write. */
async function recordWrites(page) {
  await page.evaluate(() => {
    const clipboard = navigator.clipboard;
    const original = clipboard.writeText.bind(clipboard);
    window.__leaseWrites = [];
    clipboard.writeText = async (text) => {
      window.__leaseWrites.push(text);
      return original(text);
    };
  });
}

async function writes(page) {
  return page.evaluate(() => window.__leaseWrites.slice());
}

/** Run an OSC 52 write in the pane from a client allowed to type. */
async function emitOsc52(page, text) {
  await command(page, "printf '\\033]52;c;" + b64(text) + "\\033\\\\'");
}

test('SC-09: two clients and two transports route clipboard effects to the Controller', async ({ page, browser }) => {
  test.setTimeout(300_000);
  const { sha, runtime } = verifiedRuntime('SC-09');

  // Client A creates and attaches the Session over P2P. No prompt-pattern wait:
  // the shell prompt is the runtime's (bash in CI, the host shell locally), and
  // the commands below prove the shell is live regardless of its glyphs.
  const { name } = await createAndAttach(page, expect, runtime, 'clipboard-lease', 'P2P', null);
  await recordWrites(page);

  // Client B is a separate browser with its own clipboard, attached over Relay.
  const contextB = await browser.newContext({
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const pageB = await contextB.newPage();
  try {
    await attachExisting(pageB, expect, runtime, name, 'Relay', null);
    await recordWrites(pageB);

    // B's attach activates it: B is the Controller, A now observes.
    await pageB.bringToFront();
    await expect(pageB.getByTestId('terminal-observer-bar')).toHaveCount(0);
    await expect(page.getByTestId('terminal-observer-bar')).toBeVisible({ timeout: 20_000 });

    // A Controller-typed OSC 52 write reaches the Controller's clipboard only.
    await emitOsc52(pageB, 'controller-b');
    await expect.poll(async () => writes(pageB), { timeout: 15_000 }).toEqual(['controller-b']);
    await page.waitForTimeout(500);
    expect(await writes(page)).toEqual([]);

    // The observer cannot type, so its client never triggers an effect.
    await expect(page.getByTestId('terminal-observer-bar')).toContainText('View only');
    expect(await page.evaluate(() => {
      const textarea = document.querySelector('.xterm-helper-textarea');
      return textarea?.readOnly ?? null;
    })).toBe(true);

    // A takes the lease back through the explicit affordance.
    await page.bringToFront();
    await page.getByRole('button', { name: 'Take control' }).click();
    await expect(page.getByTestId('terminal-observer-bar')).toHaveCount(0, { timeout: 20_000 });
    await expect(pageB.getByTestId('terminal-observer-bar')).toBeVisible({ timeout: 20_000 });

    await emitOsc52(page, 'controller-a');
    await expect.poll(async () => writes(page), { timeout: 15_000 }).toEqual(['controller-a']);
    await pageB.waitForTimeout(500);
    expect(await writes(pageB)).toEqual(['controller-b']);
  } finally {
    await contextB.close();
  }

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': client A (P2P) and client B (Relay) shared Session ' +
      '"' + name + '"; while B held the lease its clipboard received [controller-b] and A received ' +
      'nothing; after A took control its clipboard received [controller-a] and B stayed at ' +
      '[controller-b]; the observer input textarea was read-only',
  });
});
