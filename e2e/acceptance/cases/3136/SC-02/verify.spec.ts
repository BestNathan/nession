// #3136 SC-02: the App keeps its full-height, stacked Project form. Agent and
// Directory are full-width 44px touch fields; a long Directory grows downward;
// one host header/Back and one anchored footer stay fixed; drafts survive
// adding and removing locations; no horizontal overflow at 390/375/landscape.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { freezeFixtureClock } from '../../../../helpers/fixtureVisual';
import { verifiedRuntime } from '../../../shared/foreground-resume-browser.cjs';

async function tokenPx(page: Page, variable: string): Promise<number> {
  return page.evaluate((name) => {
    const probe = document.createElement('div');
    probe.style.cssText = `position:absolute;visibility:hidden;min-height:var(${name})`;
    const scope =
      document.querySelector('[data-experience="app"]') ?? document.body;
    scope.append(probe);
    const value = parseFloat(getComputedStyle(probe).minHeight);
    probe.remove();
    return value;
  }, variable);
}

async function settledBox(page: Page, locator: Locator) {
  await expect.poll(async () => {
    const first = await locator.boundingBox();
    await page.waitForTimeout(60);
    const second = await locator.boundingBox();
    return first && second && Math.abs(first.width - second.width) < 0.5 &&
      Math.abs(first.height - second.height) < 0.5
      ? Math.round(second.height)
      : -1;
  }).toBeGreaterThan(0);
  return (await locator.boundingBox())!;
}

async function openAppProjectForm(page: Page): Promise<Locator> {
  await page.getByTestId('app-layer-root').waitFor();
  await page.getByTestId('app-header-sessions').first().click();
  await expect(page.getByTestId('app-sessions-surface')).toBeVisible();
  await page.getByTestId('project-create').click();
  const surface = page.getByTestId('app-project-create-page');
  await expect(surface).toBeVisible();
  return surface;
}

test('SC-02: the App Project form stays stacked, touch-sized and draft-safe', async ({ page }) => {
  test.setTimeout(110_000);
  const { sha } = verifiedRuntime('SC-02');
  const observed: string[] = [];
  const longPath =
    '/Users/nathan/code/nession/.claude/worktrees/fix-3136-location-row/web/src/product/project/components/very-long-directory-name';

  for (const viewport of [
    { width: 390, height: 844 },
    { width: 375, height: 812 },
    { width: 844, height: 390 },
  ]) {
    await freezeFixtureClock(page);
    await page.setViewportSize(viewport);
    await page.goto('/#/fixture/app?projects=canonical');
    await page.reload();
    const surface = await openAppProjectForm(page);
    const band = await tokenPx(page, '--nession-control-md');
    expect(band).toBe(44);
    await expect(surface.getByTestId('app-page-header')).toHaveCount(1);

    await surface.locator('#project-create-name').fill('draft-3136');
    // The sticky action footer can overlap a pointer click after auto-scroll;
    // activating the in-form button from the keyboard is the same control.
    await surface.getByTestId('project-location-add').focus();
    await page.keyboard.press('Enter');
    const agent = page.locator('#project-create-location-agent-0');
    const path = page.locator('#project-create-location-path-0');
    const remove = page.getByTestId('project-location-remove-0');
    await expect(agent).toHaveAttribute('data-size', 'field');
    await expect(path).toHaveAttribute('data-variant', 'field');
    await expect(path).toHaveAttribute('rows', '1');

    await path.fill('/srv/nession');
    await page.waitForTimeout(120);
    const shortAgent = await settledBox(page, agent);
    const shortPath = await settledBox(page, path);
    const shortRemove = await settledBox(page, remove);
    expect(shortAgent.height).toBe(band);
    expect(shortPath.height).toBe(band);
    expect(shortRemove.height).toBeGreaterThanOrEqual(band);
    expect(shortAgent.width).toBe(shortPath.width);
    expect(shortAgent.width).toBeGreaterThan(viewport.width * 0.6);

    await path.fill(longPath);
    await page.waitForTimeout(150);
    const longAgent = await settledBox(page, agent);
    const longPathBox = await settledBox(page, path);
    expect(longPathBox.height).toBeGreaterThan(band);
    expect(longAgent.height).toBe(band);
    await expect(path).toHaveValue(longPath);
    expect(await path.evaluate((element) => element.scrollHeight <= element.clientHeight + 1))
      .toBe(true);

    await surface.getByTestId('project-location-add').focus();
    await page.keyboard.press('Enter');
    await page.locator('#project-create-location-path-1').fill('/srv/nession-two');
    await expect(surface.locator('#project-create-name')).toHaveValue('draft-3136');
    await expect(path).toHaveValue(longPath);
    await page.getByTestId('project-location-remove-1').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('project-location-editor')).toHaveCount(1);
    await expect(surface.locator('#project-create-name')).toHaveValue('draft-3136');
    await expect(path).toHaveValue(longPath);

    expect(
      await page.evaluate(() =>
        document
          .querySelector('[data-testid="app-project-create-page"]')
          ?.contains(document.activeElement) === true,
      ),
    ).toBe(true);

    await surface.evaluate((element) => { element.scrollTop = 0; });
    await page.waitForTimeout(80);
    const footer = await settledBox(page, surface.getByTestId('app-project-create-page-footer'));
    expect(Math.abs(footer.y + footer.height - viewport.height)).toBeLessThanOrEqual(1);
    expect(await surface.evaluate((element) => element.scrollWidth <= element.clientWidth + 1))
      .toBe(true);
    const { scrollWidth, width } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      width: window.innerWidth,
    }));
    expect(scrollWidth).toBeLessThanOrEqual(width + 1);
    observed.push(
      `${viewport.width}x${viewport.height}: agent ${Math.round(longAgent.height)}px, directory ${Math.round(shortPath.height)}→${Math.round(longPathBox.height)}px, footer ${Math.round(footer.y + footer.height)}`,
    );

    await expect(surface.getByTestId('app-page-back')).toBeVisible();
  }

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': ' + observed.join(' | ') +
      '; the App Project form stayed stacked/full-width on the 44px band with one header and anchored footer, preserved the draft across Add/Remove, and grew only the Directory',
  });
});
