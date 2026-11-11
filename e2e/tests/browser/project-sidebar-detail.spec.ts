import { expect, test } from '@playwright/test';

// Fixture-only Web/App navigation spec; browser execution stays CI-only by the
// repository's E2E policy.
test.skip(!process.env.CI, 'local only — runs in CI workflow only');

async function expectWebProjectDetail(page: import('@playwright/test').Page) {
  await expect(page.getByTestId('projects-section')).toBeVisible();
  await expect(page.getByTestId('project-item-row')).toHaveCount(2);

  await page.getByTestId('project-item-row').first().click();
  await expect(page.getByTestId('project-detail')).toBeVisible();
  await expect(page.getByTestId('project-detail-title')).toHaveText('Nession');
  await expect(page.getByTestId('project-source-ref')).toHaveText('main');
  await expect(page.getByTestId('project-location-row')).toHaveCount(1);
  await expect(page.getByTestId('project-image-digest')).toContainText('sha256:');
  // The Managed entry is present but fails closed: no EROFS/Sandbox runtime
  // exists yet, so it must never create a Native Session as a substitute.
  await page.getByTestId('project-detail-managed-session').click();
  const managed = page.getByTestId('project-managed-unavailable');
  await expect(managed).toBeVisible();
  await expect(managed).toContainText('no Native fallback was attempted');
  await managed.getByRole('button', { name: 'Close' }).first().click();
  await expect(managed).toHaveCount(0);
  await expect(page.getByTestId('session-item-row')).toHaveCount(6);

  // The standalone detail does not select, attach or replace the Session row.
  await expect(page.locator('[data-testid="session-item-row"][data-selected="true"]')).toHaveCount(1);

  // Selecting a Session returns to the work surface.
  const row = page.getByTestId('session-item-row').first();
  await row.getByRole('button').first().click();
  await expect(page.getByTestId('fixture-terminal')).toBeVisible();
  await expect(page.getByTestId('project-detail')).toHaveCount(0);
}

test.describe('Web Project destination', () => {
  test.use({ viewport: { width: 1180, height: 900 } });
  test('opens a standalone Project detail beside the Session list', async ({ page }) => {
    await page.goto('/#/fixture?projects=canonical');
    await expectWebProjectDetail(page);
  });
});

test.describe('Web Project destination (1024)', () => {
  test.use({ viewport: { width: 1024, height: 768 } });
  test('opens a standalone Project detail at the compact Web width', async ({ page }) => {
    await page.goto('/#/fixture?projects=canonical');
    await expectWebProjectDetail(page);
  });
});

async function expectAppProjectDetail(page: import('@playwright/test').Page) {
  await page.goto('/#/fixture/app?projects=canonical');
  await page.getByTestId('app-header-sessions').click();
  await expect(page.getByTestId('app-sessions-surface')).toBeVisible();
  await expect(page.getByTestId('project-item-row')).toHaveCount(2);

  await page.getByTestId('project-item-row').first().click();
  await expect(page.getByTestId('app-project-detail')).toBeVisible();
  await expect(page.getByTestId('project-detail-title')).toHaveText('Nession');
  // Exactly one host-owned page header at this depth.
  await expect(page.getByTestId('app-page-header')).toHaveCount(1);
  // The Terminal stays mounted under the Sessions layer.
  await expect(page.getByTestId('fixture-terminal')).toBeVisible();

  await page.getByTestId('app-page-back').click();
  await expect(page.getByTestId('app-sessions-surface')).toBeVisible();
  await expect(page.getByTestId('app-project-detail')).toHaveCount(0);
  await expect(page.getByTestId('project-item-row')).toHaveCount(2);
  await expect(page.getByTestId('fixture-terminal')).toBeVisible();
}

test.describe('App Project destination', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test('pushes Project detail from Sessions and returns with one Back', async ({ page }) => {
    await expectAppProjectDetail(page);
  });
});

test.describe('App Project destination (375)', () => {
  test.use({ viewport: { width: 375, height: 812 } });
  test('pushes Project detail at the compact App width', async ({ page }) => {
    await expectAppProjectDetail(page);
  });
});
