'use strict';
// #2710 SC-05: the Commands surface reads the existing saved-command owner,
// Insert edits the composer without executing, Run sends the command + Return,
// and unavailable actions are stated rather than faked.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const {
  addSavedCommand, openCapability, openSession, readBuffer,
} = require('../../../shared/terminal-tools-browser.cjs');
const LABEL = '2710 run marker';
const COMMAND = "printf 'COMMAND-RUN-2710\\n'";

test('SC-05: Insert edits, Run executes, and disabled states explain themselves', async ({ page }) => {
  test.setTimeout(240_000);
  const { runtime, sha } = verifiedRuntime('SC-05');
  const suffix = String(Date.now());
  await addSavedCommand(runtime, suffix, { label: LABEL, command: COMMAND });
  await openSession(page, expect, runtime, 'case-2710-sc05');

  await openCapability(page, expect, 'quick-commands');
  const insert = page.getByRole('button', { name: 'Insert ' + LABEL });
  await expect(insert).toBeVisible({ timeout: 15_000 });

  // Insert only edits the composer: the command has not run.
  await insert.click();
  await expect(page.getByTestId('capsule-ghost-input')).toHaveValue(COMMAND);
  await expect(page.getByTestId('capsule-capability-projection')).toHaveCount(0);
  await page.waitForTimeout(500);
  expect((await readBuffer(page)).includes('COMMAND-RUN-2710'),
    'Insert must not execute the command').toBe(false);

  // Run is the separate action: it executes and does not insert.
  await openCapability(page, expect, 'quick-commands');
  await page.getByRole('button', { name: 'Run ' + LABEL }).click();
  await expect.poll(async () => (await readBuffer(page)).includes('COMMAND-RUN-2710'), {
    timeout: 20_000,
  }).toBe(true);
  await expect(page.getByTestId('capsule-ghost-input')).toHaveValue('');

  // The fixture route names the disconnected input; the surface must state it.
  await openFixtureRoute(page, '/#/fixture/app?commands=disconnected');
  await openCapability(page, expect, 'quick-commands');
  await expect(page.getByTestId('quick-command-run-fixture-git-status')).toBeDisabled();
  await expect(page.getByTestId('quick-command-insert-fixture-git-status')).toBeEnabled();
  await expect(page.getByTestId('quick-commands-unavailable')).toContainText('Run is unavailable');

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': server.commands.add seeded "' + LABEL + '"; Insert left the ' +
      'composer holding the command with no COMMAND-RUN-2710 output; Run produced COMMAND-RUN-2710 ' +
      'and cleared the composer; ?commands=disconnected disabled Run (Insert stayed enabled) with ' +
      'the Run-unavailable explanation',
  });
});

async function openFixtureRoute(page, path) {
  await page.goto('about:blank');
  await page.goto(path);
  await page.getByTestId('app-layer-terminal').waitFor();
}
