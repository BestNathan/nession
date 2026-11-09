'use strict';
// #3082 SC-04: the Project capability is resolved from the focused Session's
// persisted membership only. Focusing A resolves A's Project, B resolves B's,
// and an unbound Session leaks neither. Agent offline does not erase it.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

test('SC-04: focused Session A/B recomputes Project and unbound leaks nothing', async ({ page }) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-04');
  await page.setViewportSize({ width: 1180, height: 900 });
  await page.goto('/#/fixture?projects=canonical&sessionProject=bound-ab');

  await expect(page.getByTestId('session-project-chip')).toHaveText('Nession');
  await page
    .locator('[data-session-row="devbox-01:design-system"]')
    .getByRole('button')
    .first()
    .click();
  await expect(page.getByTestId('session-project-chip')).toHaveText('Ops notes');

  await page
    .locator('[data-session-row="macbook:dotfiles"]')
    .getByRole('button')
    .first()
    .click();
  await expect(page.getByTestId('session-project-chip')).toHaveCount(0);
  await page.getByTestId('capsule-capability-more').click();
  await expect(page.getByTestId('capsule-capability-picker-project')).toHaveCount(0);
  await page.keyboard.press('Escape');

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': Session A resolved Nession, Session B resolved Ops notes, ' +
      'and the unbound Session showed no chip and no Project capability entry',
  });
});

test('SC-04: an offline Agent does not erase the bound Project', async ({ page }) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-04');
  await page.setViewportSize({ width: 1180, height: 900 });
  await page.goto('/#/fixture?projects=canonical&sessionProject=bound-offline');

  await page
    .locator('[data-session-row="sg-prod:prod-shell"]')
    .getByRole('button')
    .first()
    .click();
  await expect(page.getByTestId('session-project-chip')).toHaveText('Nession');
  await page.getByTestId('session-project-chip').click();
  await expect(page.getByTestId('project-peek-name')).toHaveText('Nession');

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': a Session on an offline Agent still resolved and opened ' +
      'its bound Project from Server-owned membership',
  });
});
