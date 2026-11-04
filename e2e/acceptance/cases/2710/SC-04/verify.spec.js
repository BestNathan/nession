'use strict';
// #2710 SC-04: Esc/Tab/Enter/arrows stay direct, repeatable and correct in
// both cursor-key modes, without dismissing the panel or moving the buffer.
//
// `/fixture/clipboard?capability=terminal-keys` mounts the production
// TerminalController and the real Keys body over a harness transport, so the
// exact PTY-bound bytes are observable and DECCKM can be toggled through the
// real parser.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

async function openKeysFixture(page) {
  await page.goto('about:blank');
  await page.goto('/#/fixture/clipboard?capability=terminal-keys');
  await page.getByTestId('fixture-clipboard').waitFor();
  await page.waitForFunction(() => Boolean(window.clipboardHarness));
  await page.waitForFunction(() => Boolean(
    document.querySelector('[data-testid="capsule-capability-projection"]') &&
    document.querySelector('[data-testid="terminal-keys-body"]'),
  ));
}

async function sent(page) {
  return page.evaluate(() => window.clipboardHarness.sent.slice());
}

async function clearSent(page) {
  await page.evaluate(() => {
    window.clipboardHarness.sent.length = 0;
  });
}

test('SC-04: direct keys are repeatable and follow the terminal mode', async ({ page }) => {
  test.setTimeout(120_000);
  const { sha } = verifiedRuntime('SC-04');
  await openKeysFixture(page);

  // Two Tabs prove repeatability.
  await clearSent(page);
  await page.getByTestId('phys-key-Tab').click();
  await page.getByTestId('phys-key-Tab').click();
  await expect.poll(async () => (await sent(page)).join('')).toBe('\t\t');

  // Enter and an arrow prove the other direct actions still produce their own
  // bytes.
  await clearSent(page);
  await page.getByTestId('phys-key-Enter').click();
  await page.getByTestId('phys-key-↑').click();
  await expect.poll(async () => (await sent(page)).join('')).toBe('\r\x1b[A');

  // Keys never dismiss the panel.
  await expect(page.getByTestId('terminal-keys-body')).toBeVisible();

  // Application cursor mode changes the unmodified arrow spelling through the
  // real parser, not through a fixture flag.
  await clearSent(page);
  await page.evaluate(() => window.clipboardHarness.emit('\x1b[?1h'));
  await expect.poll(() => page.evaluate(() => {
    const xterm = document.querySelector('.xterm');
    return xterm?.parentElement?.xtermInstance?.modes?.applicationCursorKeysMode === true;
  })).toBe(true);
  await page.getByTestId('phys-key-↑').click();
  await page.getByTestId('phys-key-↓').click();
  await expect.poll(async () => (await sent(page)).join('')).toBe('\x1bOA\x1bOB');

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': two Tab taps sent two HT frames; Enter+ArrowUp sent ' +
      'CR + CSI A; after the real DECSET 1 parser path, ArrowUp/ArrowDown sent SS3 A/B; the panel stayed open',
  });
});
