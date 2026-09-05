import { test, expect } from '@playwright/test';
import { waitForDashboard } from '../helpers/dashboard';

/**
 * Read the xterm buffer text via the `xtermInstance` property exposed on the
 * container element by TerminalInstance.attach().  Canvas/webgl renderers
 * don't put text in the DOM, so this is the reliable way to assert on
 * terminal output.
 */
async function readTerminalBuffer(page: import('@playwright/test').Page): Promise<string> {
  return page.evaluate(() => {
    const xtermEl = document.querySelector('.xterm');
    const container = xtermEl?.parentElement;
    // xtermInstance is set by TerminalInstance.attach()
    const term = (container as Record<string, unknown>)?.xtermInstance as
      | { buffer: { active: { length: number; getLine(y: number): { translateToString(): string } | undefined } } }
      | undefined;
    if (!term) {return '';}
    const buffer = term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buffer.length; i++) {
      const line = buffer.getLine(i);
      if (line) {lines.push(line.translateToString());}
    }
    return lines.join('\n');
  });
}

/** Wait for the xterm terminal to be mounted and ready. */
async function waitForTerminal(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('.xterm').waitFor({ state: 'visible', timeout: 15_000 });
  // Wait until the xtermInstance property is set (terminal instance is mounted)
  await expect(async () => {
    const text = await readTerminalBuffer(page);
    // Buffer exists even if empty — we just need xtermInstance to be set
    expect(text).toBeDefined();
  }).toPass({ timeout: 5_000 });
}

/** Create a session via the UI and return its name. */
async function createSession(page: import('@playwright/test').Page, name: string): Promise<void> {
  const createButton = page.getByRole('button', { name: 'Create' });
  await expect(createButton).toBeEnabled({ timeout: 15_000 });
  await createButton.click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await page.locator('#name').fill(name);
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(dialog).not.toBeVisible({ timeout: 10_000 });

  // Wait for session to appear in list
  await expect(page.locator(`p.font-medium:has-text("${name}")`)).toBeVisible({ timeout: 10_000 });
}

/** Attach to a session via the UI, selecting the specified mode. */
async function attachToSession(
  page: import('@playwright/test').Page,
  sessionName: string,
  mode: 'Auto' | 'P2P' | 'Relay',
): Promise<void> {
  // Find the session row by the hover class and the session name within it
  const row = page.locator('div[class*="hover:bg-accent"]', {
    has: page.locator(`p:has-text("${sessionName}")`),
  });
  await row.getByRole('button', { name: 'Attach', exact: true }).click();

  // AttachDialog opens
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();

  // Select the desired mode. The ModeToggle renders three buttons whose
  // accessible names include both the mode label AND the hint (e.g.
  // "Relay Proxy through server (works behind NAT/firewalls)"). A plain
  // { name: 'Relay' } substring match therefore picks up the Auto buttons
  // too (their hint text happens to contain the search string). Anchoring
  // at the start with a regex restricts matches to the mode whose label
  // actually begins with the name we want.
  await dialog.getByRole('button', { name: new RegExp(`^${mode}\\b`) }).click();

  // Wait for the Attach button to be enabled (attachInfo loaded)
  const attachButton = dialog.getByRole('button', { name: 'Attach' });
  await expect(attachButton).toBeEnabled({ timeout: 10_000 });
  await attachButton.click();

  // Dialog closes and terminal view loads
  await expect(dialog).not.toBeVisible({ timeout: 5_000 });
}

/** Type a command into the xterm terminal. */
async function typeInTerminal(page: import('@playwright/test').Page, text: string): Promise<void> {
  // xterm captures input via the hidden helper textarea
  const helper = page.locator('.xterm-helper-textarea');
  await helper.waitFor({ state: 'attached', timeout: 5_000 });
  await helper.focus();
  await page.keyboard.type(text, { delay: 20 });
}

// NOTE: these tests are CI-gated per repo convention (the fixture specs use
// the same `test.skip(!process.env.CI, ...)` pattern): they drive a real
// tmux-backed agent, which the e2e webServer stack only provides in CI. The
// historical blocker ("terminal does not support clear" at tmux session
// creation) is stale — the agent forces TERM=xterm-256color when creating
// sessions. A failure here in CI is a genuine regression: investigate it,
// don't re-skip the test.
test.describe('Terminal I/O', () => {
  test.beforeEach(async ({ page }) => {
    // Use direct WS URL to bypass vite preview's flaky WS proxy.
    await page.goto('/?token=e2e-test-token&server_url=' + encodeURIComponent('ws://localhost:19090/ws'));
    await waitForDashboard(page);
  });

  test('relay mode: echo command and verify output', async ({ page }) => {
    test.skip(!process.env.CI, 'local only — runs in CI workflow only');
    const SESSION_NAME = 'e2e-terminal-relay';
    await createSession(page, SESSION_NAME);
    await attachToSession(page, SESSION_NAME, 'Relay');

    // Wait for the terminal to mount
    await waitForTerminal(page);

    // Type a command
    await typeInTerminal(page, 'echo nession-e2e-ok\n');

    // Wait for the output to appear in the buffer
    await expect(async () => {
      const text = await readTerminalBuffer(page);
      expect(text).toContain('nession-e2e-ok');
    }).toPass({ timeout: 15_000 });
  });

  test('P2P mode: echo command and verify output', async ({ page }) => {
    test.skip(!process.env.CI, 'local only — runs in CI workflow only');
    const SESSION_NAME = 'e2e-terminal-p2p';
    await createSession(page, SESSION_NAME);
    await attachToSession(page, SESSION_NAME, 'P2P');

    // Wait for the terminal to mount
    await waitForTerminal(page);

    // Type a command
    await typeInTerminal(page, 'echo nession-e2e-ok\n');

    // Wait for the output to appear in the buffer
    await expect(async () => {
      const text = await readTerminalBuffer(page);
      expect(text).toContain('nession-e2e-ok');
    }).toPass({ timeout: 15_000 });
  });
});
