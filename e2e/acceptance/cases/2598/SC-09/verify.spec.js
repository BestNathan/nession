'use strict';
// #2598 SC-09: two real clients on one Session (P2P and Relay). Clipboard
// effects and protocol replies belong to the authorized Controller, not to an
// observer and not to whichever client merely attached last.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/terminal-clipboard-cases.cjs');
const {
  createAndAttach, command,
} = require('../../../shared/foreground-resume-browser.cjs');

/**
 * Attach an existing Session from a second client. The row's configure control
 * opens the "Attach: <session>" dialog; choosing a mode either starts the
 * attach (an Attach button) or stages it for Save, depending on the saved
 * choice. Both are the authorized UI paths, so wait for the dialog to close
 * and the terminal to attach.
 */
async function attachClient(page, expect, runtime, name, mode) {
  const wsUrl = 'ws://127.0.0.1:' + runtime.server_port + '/ws';
  await page.goto('/?token=e2e-test-token&server_url=' + encodeURIComponent(wsUrl));
  await expect(page.getByTestId('shell')).toBeVisible({ timeout: 25000 });
  const row = page.locator('[data-testid="session-item-row"]', { hasText: name });
  await expect(row).toBeVisible({ timeout: 30000 });
  const configure = page.getByRole('button', { name: /Configure attach settings/ }).first();
  if (await configure.isVisible().catch(() => false)) {
    await configure.click({ force: true });
  } else {
    await row.getByRole('button').first().click();
  }
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: new RegExp('^' + mode + '\\b') }).click();
  const attach = dialog.getByRole('button', { name: 'Attach' });
  if (await attach.isVisible().catch(() => false)) {
    await attach.click();
  } else {
    const save = dialog.getByRole('button', { name: 'Save' });
    await expect(save).toBeVisible();
    await save.click();
  }
  await expect(dialog).not.toBeVisible({ timeout: 15000 });
  // Saving a staged choice configures the attach; selecting the row starts it.
  if (!(await page.locator('.xterm').isVisible().catch(() => false))) {
    await row.click({ force: true });
  }
  await expect(page.locator('.xterm')).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId('terminal-connecting')).toBeHidden({ timeout: 30000 });
  await expect(page.getByTestId('terminal-loading')).toBeHidden({ timeout: 30000 });
}

const b64 = (value) => Buffer.from(value, 'utf8').toString('base64');

// The default page is client A; client B gets the same grant on its own context.
test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

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
    await attachClient(pageB, expect, runtime, name, 'Relay');
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

    // The observer's xterm has stdin disabled, so its client never triggers an
    // effect; the Controller's terminal keeps input enabled.
    await expect(page.getByTestId('terminal-observer-bar')).toContainText('View only');
    const stdinDisabled = () => page.evaluate(() => {
      const visible = Array.from(document.querySelectorAll('.xterm')).find((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      const terminal = visible?.parentElement?.xtermInstance;
      return terminal?.options?.disableStdin ?? null;
    });
    expect(await stdinDisabled()).toBe(true);
    expect(await pageB.evaluate(() => {
      const visible = Array.from(document.querySelectorAll('.xterm')).find((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      const terminal = visible?.parentElement?.xtermInstance;
      return terminal?.options?.disableStdin ?? null;
    })).toBe(false);

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
