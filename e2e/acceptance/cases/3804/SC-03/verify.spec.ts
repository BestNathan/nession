// #3804 SC-03: Web and App Session lists show distinct working/idle/unknown/
// needs-input outcomes with accessible semantics, preserve Session identity and
// one parenthesised row-actions menu, and stay navigable by keyboard and touch
// at compact widths.
import { expect, test, type Page } from '@playwright/test';
import { freezeFixtureClock, gotoFixtureApp } from '../../../../helpers/fixtureVisual';

const ROUTE = '/#/fixture?sessionActivity=canonical';
const APP_ROUTE = '/#/fixture/app?sessionActivity=canonical';

const ROWS = {
  working: 'devbox-01:fix-terminal-reconnect',
  needsInput: 'devbox-01:design-system',
  idle: 'devbox-01:staging-deploy',
  unknown: 'macbook:review-pr-561',
  offline: 'sg-prod:prod-shell',
} as const;

async function assertActivityReadings(page: Page): Promise<void> {
  for (const [state, sessionId] of [
    ['working', ROWS.working],
    ['working', ROWS.needsInput],
    ['idle', ROWS.idle],
    ['unknown', ROWS.unknown],
    ['unknown', ROWS.offline],
  ] as const) {
    const row = page.locator(`[data-session-row="${sessionId}"]`);
    await expect(row, sessionId).toHaveAttribute('data-activity', state);
  }

  await expect(
    page.locator(`[data-session-row="${ROWS.needsInput}"]`),
  ).toHaveAttribute('data-attention', 'input_required');
  await expect(
    page.locator(`[data-session-row="${ROWS.needsInput}"]`).getByTestId('session-item-attention'),
  ).toHaveText('Needs input');
  await expect(
    page.locator(`[data-session-row="${ROWS.offline}"]`).getByText('Agent offline'),
  ).toBeVisible();

  // The reading is spoken, not only drawn.
  await expect(page.getByTestId(`session-item-${ROWS.working}`)).toHaveAccessibleName(
    /Activity: Working/,
  );
  await expect(page.getByTestId(`session-item-${ROWS.idle}`)).toHaveAccessibleName(
    /Activity: Idle/,
  );
  await expect(page.getByTestId(`session-item-${ROWS.unknown}`)).toHaveAccessibleName(
    /Activity: Unknown/,
  );
  await expect(page.getByTestId(`session-item-${ROWS.needsInput}`)).toHaveAccessibleName(
    /Activity: Working — needs user input/,
  );
  await expect(page.getByTestId(`session-item-${ROWS.offline}`)).toHaveAccessibleName(
    /Activity: Unknown — Agent unreachable/,
  );

  // One fixed-size slot per row: the state never moves the title.
  const geometry = await page
    .getByTestId('session-item-activity')
    .evaluateAll((elements) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return { width: Math.round(rect.width), height: Math.round(rect.height) };
      }),
    );
  expect(geometry.length).toBeGreaterThanOrEqual(5);
  expect(new Set(geometry.map((box) => `${box.width}x${box.height}`)).size).toBe(1);
  expect(geometry[0].width).toBeGreaterThan(0);

  // Exactly one anchored actions trigger per row; the glyph is not a control.
  for (const sessionId of Object.values(ROWS)) {
    await expect(page.getByTestId(`session-actions-${sessionId}`)).toHaveCount(1);
  }
}

async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
}

test.describe('Web Session list', () => {
  for (const viewport of [
    { width: 1180, height: 900 },
    { width: 1024, height: 768 },
  ]) {
    test(`SC-03: Web ${viewport.width} distinguishes every Activity outcome`, async ({ page }) => {
      test.setTimeout(60_000);
      const sha = String(process.env.NESSION_ACCEPTANCE_TARGET_SHA ?? '');
      expect(sha).toMatch(/^[0-9a-f]{40}$/);

      await freezeFixtureClock(page);
      await page.setViewportSize(viewport);
      await page.goto(ROUTE);
      await expect(page.getByTestId('sidebar')).toBeVisible();
      await assertActivityReadings(page);
      await assertNoHorizontalOverflow(page);

      // Keyboard reaches the row and selects it; the glyph slot did not
      // remove the row's identity.
      const row = page.getByTestId(`session-item-${ROWS.unknown}`);
      await row.focus();
      await expect(row).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(
        page.locator(`[data-session-row="${ROWS.unknown}"]`),
      ).toHaveAttribute('data-selected', 'true');

      // One anchored actions menu, opened from the row, never selecting it as
      // a side effect.
      const actions = page.getByTestId(`session-actions-${ROWS.working}`);
      // Wide Web reveals the trigger on hover/focus/selection; the row itself
      // is the hover surface, because the hidden trigger has no pointer events.
      await page.locator(`[data-session-row="${ROWS.working}"]`).hover();
      await actions.click();
      await expect(page.getByRole('menu')).toBeVisible();
      await expect(
        page.locator(`[data-session-row="${ROWS.working}"]`),
      ).toHaveAttribute('data-selected', 'false');
      await page.keyboard.press('Escape');
      await expect(page.getByRole('menu')).toHaveCount(0);

      test.info().annotations.push({
        type: 'evidence',
        description:
          `exact SHA ${sha}: Web ${viewport.width}x${viewport.height} rendered working, ` +
          'working+needs-input, idle, absent-unknown and offline-Agent unknown as ' +
          'distinct fixed-slot glyphs with spoken Activity labels; the row stayed ' +
          'keyboard-selectable, its identity and single actions menu were preserved, ' +
          'and the list had no horizontal overflow',
      });
    });
  }
});

test.describe('App Session list', () => {
  test.use({ hasTouch: true });
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 375, height: 812 },
  ]) {
    test(`SC-03: App ${viewport.width} distinguishes every Activity outcome`, async ({ page }) => {
      test.setTimeout(60_000);
      const sha = String(process.env.NESSION_ACCEPTANCE_TARGET_SHA ?? '');
      expect(sha).toMatch(/^[0-9a-f]{40}$/);

      await freezeFixtureClock(page);
      await page.setViewportSize(viewport);
      await gotoFixtureApp(page, '?sessionActivity=canonical');
      if ((await page.getByTestId('app-layer-root').getAttribute('data-layer')) !== 'sessions') {
        await page.getByTestId('app-header-sessions').first().tap();
      }
      await expect(page.getByTestId('app-layer-sessions')).toBeVisible();
      await assertActivityReadings(page);
      await assertNoHorizontalOverflow(page);

      // The row actions keep a touch-sized target and a single menu.
      const actions = page.getByTestId(`session-actions-${ROWS.working}`);
      const box = await actions.boundingBox();
      expect(box, 'the actions trigger is rendered').not.toBeNull();
      expect(Math.min(box!.width, box!.height)).toBeGreaterThanOrEqual(44);
      await actions.tap();
      await expect(page.getByRole('menu')).toBeVisible();
      await page.keyboard.press('Escape');

      // Touch navigation: tapping a row enters its Terminal, and the shared
      // Back returns to the same Sessions layer.
      await page.getByTestId(`session-item-${ROWS.idle}`).tap();
      await expect(page.getByTestId('app-layer-root')).toHaveAttribute(
        'data-layer',
        'terminal',
      );
      // The resting Terminal Capsule gains no Activity spinner.
      await expect(
        page.locator('[data-testid="terminal-capsule"] [role="progressbar"]'),
      ).toHaveCount(0);
      await page.getByTestId('app-header-sessions').first().tap();
      await expect(page.getByTestId('app-layer-root')).toHaveAttribute(
        'data-layer',
        'sessions',
      );

      test.info().annotations.push({
        type: 'evidence',
        description:
          `exact SHA ${sha}: App ${viewport.width}x${viewport.height} with touch ` +
          'rendered the same five distinct Activity outcomes with spoken labels, a ' +
          '44px actions target and one menu; tapping a row entered its Terminal and ' +
          'the shared Back returned to Sessions without horizontal overflow',
      });
    });
  }
});
