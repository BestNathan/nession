'use strict';
// #2710 SC-01: at App widths 375/390/430, Keys and Commands are one bounded
// upper slot, the lower composer does not move, and the Terminal is never
// unmounted.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const {
  dismissCapability, markTerminal, openCapability, openSession, terminalGeometry,
} = require('../../../shared/terminal-tools-browser.cjs');

test('SC-01: one bounded upper slot at 375/390/430 without composer movement', async ({ page }) => {
  test.setTimeout(240_000);
  const { runtime, sha } = verifiedRuntime('SC-01');
  await openSession(page, expect, runtime, 'case-2710-sc01');
  await markTerminal(page);

  const results = [];
  for (const [width, height] of [[375, 667], [390, 844], [430, 932]]) {
    await page.setViewportSize({ width, height });
    await expect(page.getByTestId('terminal-capsule')).toBeVisible();

    const resting = await terminalGeometry(page);
    if (!resting) throw new Error('terminal geometry unavailable at ' + width);
    const shell = resting.shellBox;

    await openCapability(page, expect, 'terminal-keys');
    const keys = await terminalGeometry(page);
    if (!keys) throw new Error('terminal geometry unavailable with Keys at ' + width);
    expect(keys.shellBox, width + ': Keys must not move the composer').toEqual(shell);
    expect(keys.upperHeight, width + ': Keys stays a bounded slot').toBeLessThanOrEqual(
      await maxProjectionHeight(page) + 1,
    );
    expect(keys.occlusion, width + ': fit occlusion must not grow').toBe(resting.occlusion);

    await page.getByTestId('capsule-view-quick-commands').click();
    await expect(page.getByTestId('quick-commands-body')).toBeVisible();
    const commands = await terminalGeometry(page);
    if (!commands) throw new Error('terminal geometry unavailable with Commands at ' + width);
    expect(commands.shellBox, width + ': Commands must not move the composer').toEqual(shell);
    expect(commands.upperHeight, width + ': Commands stays a bounded slot').toBeLessThanOrEqual(
      await maxProjectionHeight(page) + 1,
    );
    expect(commands.occlusion, width + ': fit occlusion must not grow').toBe(resting.occlusion);
    // One upper slot, not two surfaces: switching replaced the content.
    await expect(page.getByTestId('capsule-capability-projection')).toHaveCount(1);
    await expect(page.getByTestId('terminal-keys-body')).toHaveCount(0);

    await dismissCapability(page, expect);
    expect(await page.locator('.xterm[data-2710-terminal="original"]').count(),
      width + ': the Terminal must not be unmounted').toBe(1);
    results.push({ width, shell, keysHeight: keys.upperHeight, commandsHeight: commands.upperHeight });
  }

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': one upper slot at ' + JSON.stringify(results) +
      '; composer box identical, projection height bounded, occlusion unchanged, xterm node preserved',
  });
});

async function maxProjectionHeight(page) {
  return page.evaluate(() => {
    const projection = document.querySelector('[data-testid="capsule-capability-projection"]');
    if (!(projection instanceof HTMLElement)) return 0;
    const raw = getComputedStyle(projection).maxHeight;
    return Number.parseFloat(raw) || 0;
  });
}
