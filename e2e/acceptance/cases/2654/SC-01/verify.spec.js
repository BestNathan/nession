'use strict';
// #2654 SC-01: entering Environment with a current Session opens the Session
// Environment as the default main content — identity, observed state and the
// ordered mounted profiles — while the bounded Profile navigator stays usable
// and a profile detail returns to the Session.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

test('SC-01: Session Environment is the Web default and the navigator stays usable', async ({ page }) => {
  test.setTimeout(90_000);
  const { runtime, sha } = verifiedRuntime('SC-01');
  expect(runtime.profile).toBe('full-stack-local');

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/fixture/workspace?capability=env');
  await expect(page.getByTestId('env-profile-list')).toBeVisible({ timeout: 25_000 });

  // Default main content is the Session Environment, not an empty pane.
  const overview = page.getByTestId('env-session-environment');
  await expect(overview).toBeVisible({ timeout: 25_000 });
  await expect(page.getByTestId('env-session-status-title')).toHaveText('In sync');
  await expect(page.getByTestId('env-session-profiles')).toContainText('staging.env');
  await expect(page.getByTestId('env-manage-binding')).toBeVisible();

  // The navigator remains an independent, searchable profile index.
  await expect(page.getByTestId('env-search')).toBeVisible();
  await page.getByTestId('env-profile-row-agent:devbox-01:prod.env').click();
  await expect(page.getByTestId('env-profile-detail')).toBeVisible();
  await expect(page.getByTestId('env-profile-included')).toHaveCount(0);
  await expect(page.getByTestId('env-var-masked-DB_PASSWORD')).toBeVisible();

  // A visible action returns to the Session view; no permanent duplicate tabs.
  await page.getByTestId('env-profile-session-link').click();
  await expect(overview).toBeVisible();
  await expect(page.getByTestId('env-session-status-title')).toHaveText('In sync');
  expect(await page.getByRole('tab').count()).toBeLessThanOrEqual(2);

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': Web 1440x900 opened the Session Environment by default ' +
      '(in sync, staging.env mounted), kept the searchable profile navigator, pushed the read-first ' +
      'prod.env detail with a masked secret, and returned to the Session through the visible link',
  });
});
