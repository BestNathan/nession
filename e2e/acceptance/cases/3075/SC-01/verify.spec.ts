// #3075 SC-01: the collapsed Web sidebar reserves the agreed 56px rail and
// reallocates only the released width to Main. Measured rectangles must show
// adjacency rather than overlap at 1024/1180/1280/1440, and re-expanding must
// not overflow the viewport while a Terminal grid is mounted.
import { expect, test } from '@playwright/test';
import {
  freezeFixtureClock,
  gotoFixtureShell,
  waitForFixtureTerminal,
} from '../../../../helpers/fixtureVisual';
import { verifiedRuntime } from '../../../shared/foreground-resume-browser.cjs';

test('SC-01: the rail occupies 56px in flow and Main starts at its right edge', async ({ page }) => {
  // The browser-verifier process is killed at 120s; fail inside it first.
  test.setTimeout(110_000);
  const { sha } = verifiedRuntime('SC-01');
  const observed: string[] = [];

  for (const width of [1440, 1280, 1180, 1024]) {
    await freezeFixtureClock(page);
    await page.setViewportSize({ width, height: 900 });
    await gotoFixtureShell(page);
    await waitForFixtureTerminal(page);

    const railWidth = await page.evaluate(() =>
      parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue(
          '--nession-shell-rail-width',
        ),
      ),
    );
    expect(railWidth, 'the rail width is an owned shell token').toBe(56);

    const column = page.getByTestId('sidebar-column');
    const main = page.locator('main');

    expect((await column.boundingBox())?.width, 'expanded column').toBe(246);
    const expandedMain = await main.boundingBox();
    expect(expandedMain).not.toBeNull();

    await page.getByTestId('sidebar-collapse').click();

    // The column keeps a real 56px rail in flow; Main is not covered.
    await expect.poll(async () => (await column.boundingBox())?.width ?? -1).toBe(railWidth);
    const rail = page.getByTestId('sidebar-rail');
    await expect(rail).toBeVisible();
    await expect(page.getByTestId('sidebar-open')).toHaveCount(0);

    const railBox = await rail.boundingBox();
    const mainBox = await main.boundingBox();
    expect(railBox, 'rail box at ' + width).not.toBeNull();
    expect(mainBox, 'main box at ' + width).not.toBeNull();
    expect(railBox!.width).toBeCloseTo(railWidth, 1);
    expect(mainBox!.x).toBeGreaterThanOrEqual(railBox!.x + railBox!.width - 0.5);
    expect(mainBox!.x + mainBox!.width).toBeLessThanOrEqual(width + 0.5);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
      'no horizontal overflow while collapsed at ' + width,
    ).toBeLessThanOrEqual(width + 1);
    expect(
      await page.getByTestId('terminal-surface').isVisible(),
      'the Terminal stays mounted and visible',
    ).toBe(true);

    // Only the released sidebar width returns to Main, and re-expansion still
    // fits inside the viewport with a Terminal grid mounted.
    await page.getByTestId('sidebar-rail-expand').click();
    await expect.poll(async () => (await column.boundingBox())?.width ?? 0).toBe(246);
    const reExpandedMain = await main.boundingBox();
    expect(reExpandedMain).not.toBeNull();
    expect(reExpandedMain!.x + reExpandedMain!.width).toBeLessThanOrEqual(width + 0.5);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
      'no horizontal overflow after re-expansion at ' + width,
    ).toBeLessThanOrEqual(width + 1);

    observed.push(
      `${width}: expanded 246 / rail ${railWidth}; main.x=${mainBox!.x.toFixed(1)} ` +
        `rail.right=${(railBox!.x + railBox!.width).toFixed(1)}; ` +
        `main.right=${(reExpandedMain!.x + reExpandedMain!.width).toFixed(1)}; overflow 0`,
    );
  }

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': measured in-flow 56px rail at 1024/1180/1280/1440; ' +
      observed.join(' | '),
  });
});
