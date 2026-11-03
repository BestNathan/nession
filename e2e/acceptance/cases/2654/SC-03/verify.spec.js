'use strict';
// #2654 SC-03: the observed status is truthful. Healthy is quiet; pending
// speaks about the next shell prompt; outdated is disclosed and repaired only
// through explicit Reapply; unsupported/error/unavailable carry the Agent's
// reasons. No state claims that a running TUI changed immediately.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

const STAGING_KEY = 'server::staging.env';
const PROD_KEY = 'agent:devbox-01:prod.env';

async function openScenario(page, scenario) {
  const suffix = scenario ? '&env=' + scenario : '';
  await page.goto('/#/fixture/workspace?capability=env' + suffix);
  await expect(page.getByTestId('env-session-status')).toBeVisible({ timeout: 25_000 });
  return page.getByTestId('env-session-status');
}

test('SC-03: observed states are distinct, explained and never claim immediate TUI mutation', async ({ page }) => {
  test.setTimeout(120_000);
  const { sha } = verifiedRuntime('SC-03');
  await page.setViewportSize({ width: 1440, height: 900 });

  // Healthy: one quiet line, revisions behind Details, no success badge.
  let status = await openScenario(page, '');
  await expect(status).toHaveAttribute('data-status', 'in_sync');
  await expect(status).toHaveAttribute('data-tone', 'quiet');
  await expect(page.getByTestId('env-session-status-title')).toHaveText('In sync');
  await expect(page.getByTestId('env-session-details-body')).toHaveCount(0);
  await page.getByTestId('env-session-details').click();
  await expect(page.getByTestId('env-session-details-body')).toContainText('Applied revision');

  // Pending: the next-prompt boundary, not "already updated in the shell".
  status = await openScenario(page, 'pending');
  await expect(status).toHaveAttribute('data-status', 'pending_shell');
  await expect(status).toHaveAttribute('data-tone', 'info');
  await expect(page.getByTestId('env-session-status-title')).toHaveText(
    'Waiting for the next shell prompt',
  );
  await expect(page.getByTestId('env-session-status-detail')).toContainText(
    'next prompt',
  );
  await expect(page.locator('body')).not.toContainText(/already (updated|applied)/i);
  await expect(page.locator('body')).not.toContainText(/updated immediately/i);

  // Outdated: disclosed, and only an explicit Reapply repairs it.
  status = await openScenario(page, 'outdated');
  await expect(page.getByTestId('env-session-outdated')).toContainText(
    'changed since this Session materialized',
  );
  await expect(page.getByTestId('env-session-reapply')).toBeVisible();
  await page.getByTestId('env-session-reapply').click();
  await expect(page.getByTestId('env-session-status-title')).toHaveText('In sync');
  await expect(page.getByTestId('env-session-outdated')).toHaveCount(0);

  // Unsupported shell: the Agent's reason plus what still works.
  status = await openScenario(page, 'unsupported');
  await expect(status).toHaveAttribute('data-status', 'unsupported_shell');
  await expect(status).toHaveAttribute('data-tone', 'warning');
  await expect(page.getByTestId('env-session-status-title')).toHaveText('Unsupported shell');
  await expect(page.getByTestId('env-session-status-detail')).toContainText(
    'No Session-local adapter for shell /usr/bin/fish.',
  );
  await expect(page.getByTestId('env-session-status-detail')).toContainText(
    'New panes and processes still inherit the environment.',
  );

  // Materialization error: the error is local and Reapply is offered.
  status = await openScenario(page, 'error');
  await expect(status).toHaveAttribute('data-status', 'error');
  await expect(status).toHaveAttribute('data-tone', 'error');
  await expect(page.getByTestId('env-session-status-detail')).toContainText(
    'permission denied',
  );
  await expect(page.getByTestId('env-session-reapply')).toBeVisible();

  // Unobserved: unavailable with an explicit Retry, never a guessed in-sync.
  status = await openScenario(page, 'unavailable');
  await expect(status).toHaveAttribute('data-status', 'unavailable');
  await expect(page.getByTestId('env-session-status-title')).toHaveText('Status unavailable');
  await expect(page.getByTestId('env-session-retry')).toBeVisible();

  // Apply itself produces pending, not a fabricated success.
  status = await openScenario(page, '');
  await page.getByTestId('env-manage-binding').click();
  await page.getByTestId('env-draft-add-' + PROD_KEY).click();
  await page.getByTestId('env-draft-apply').click();
  await expect(page.getByTestId('env-session-status')).toHaveAttribute(
    'data-status', 'pending_shell',
  );
  await expect(page.getByTestId('env-session-profile-' + STAGING_KEY)).toBeVisible();
  await expect(page.getByTestId('env-session-profile-' + PROD_KEY)).toBeVisible();

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': observed in-sync (quiet, Details-only revisions), pending_shell ' +
      '(next-prompt copy, no immediate-update claim), outdated (Reapply clears it), unsupported_shell ' +
      '(fish adapter reason + inherited new processes), error (permission denied + Reapply), and ' +
      'unavailable (Retry) were all distinct; Apply reported pending_shell, not success',
  });
});
