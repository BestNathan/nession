// #2875 SC-01: at the two native App widths each Session row exposes one
// touch-safe `···` anchored menu with all four task-level actions, and opening
// it neither selects the row nor unmounts the Terminal layer.
//
// The deterministic App fixture is the real App composition with fixture data;
// the Acceptance runtime supplies the same built web app.
import { expect, test } from '@playwright/test';
import { freezeFixtureClock, gotoFixtureApp } from '../../../../helpers/fixtureVisual';

const TARGET = 'devbox-01:design-system';

async function openAppSessions(
  page: import('@playwright/test').Page,
  viewport: { width: number; height: number },
): Promise<void> {
  await freezeFixtureClock(page);
  await page.setViewportSize(viewport);
  await gotoFixtureApp(page, '?sessionMetadata=normal');
  // A same-hash navigation does not reload the document: when the App is
  // already on its Sessions layer, that layer covers the header trigger.
  if ((await page.getByTestId('app-layer-root').getAttribute('data-layer')) !== 'sessions') {
    await page.getByTestId('app-header-sessions').first().click();
  }
  await expect(page.getByTestId('app-layer-sessions')).toBeInViewport();
  await expect(page.getByTestId('app-sessions-surface')).toBeVisible();
}

test('SC-01: four anchored actions at 390x844 and 375x812 without side effects', async ({ page }) => {
  test.setTimeout(180_000);
  const sha = String(process.env.NESSION_ACCEPTANCE_TARGET_SHA ?? '');
  expect(sha).toMatch(/^[0-9a-f]{40}$/);
  const observed: string[] = [];

  for (const viewport of [
    { width: 390, height: 844 },
    { width: 375, height: 812 },
  ]) {
    await openAppSessions(page, viewport);

    const selectedRow = page.locator('[data-testid="session-item-row"][data-selected="true"]');
    const selectedBefore = await selectedRow.getAttribute('data-session-row');
    await page.getByTestId('app-layer-terminal').evaluate((element) => {
      (element as HTMLElement).dataset.kept = '2875';
    });

    const trigger = page.getByTestId(`session-actions-${TARGET}`);
    const box = await trigger.boundingBox();
    expect(box?.width, 'the App action control keeps its touch band').toBe(44);
    expect(box?.height).toBe(44);

    await trigger.click();
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem')).toHaveCount(4);
    for (const label of ['Session details', 'Edit details', 'Attach settings', 'Kill session']) {
      await expect(menu.getByRole('menuitem', { name: label })).toBeVisible();
    }
    await expect(menu.getByRole('separator')).toHaveCount(1);

    // The menu is an overlay on the App's Sessions layer: the selected Session
    // is untouched and the Terminal layer keeps the same mounted node.
    await expect(page.getByTestId('app-layer-root')).toHaveAttribute('data-layer', 'sessions');
    expect(await selectedRow.getAttribute('data-session-row')).toBe(selectedBefore);
    expect(
      await page.getByTestId('app-layer-terminal').evaluate(
        (element) => (element as HTMLElement).dataset.kept,
      ),
    ).toBe('2875');

    // The App-owned scroll viewport is the dismissal owner.
    await page
      .getByTestId('app-sessions-list')
      .locator('[data-slot="scroll-area-viewport"]')
      .first()
      .evaluate((element) => {
        element.scrollTop = 40;
        element.dispatchEvent(new Event('scroll'));
      });
    await expect(menu).toHaveCount(0);
    await expect(trigger).toBeFocused();

    await expect(page.getByPlaceholder('Search sessions...')).toBeVisible();
    await expect(page.getByTestId('session-group-label').first()).toBeVisible();
    await expect(page.getByTestId('create-session')).toBeVisible();
    observed.push(`${viewport.width}x${viewport.height}: 44px trigger, 4 items, selection unchanged, terminal kept`);
  }

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': ' + observed.join('; ') +
      '; the App-owned list scroll dismissed the menu and focus returned to the trigger',
  });
});
