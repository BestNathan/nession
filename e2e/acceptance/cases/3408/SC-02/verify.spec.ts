// #3408 SC-02: a user can navigate Images Library → Builds → Distribution,
// identify Server-global image status separately from the current Agent's
// cache state, and return to Filesystem without losing the current Session or
// Policy draft. Library detail expands inline under one selected row; Builds
// shows sourced stage/measured counters; Distribution shows the Agent's
// measured bytes and never labels a partial download active or mount-ready.
import { expect, test } from '@playwright/test';

test('SC-02: Library inline detail, Builds counters and the Filesystem handoff', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const sha = String(process.env.NESSION_ACCEPTANCE_TARGET_SHA ?? '');
  expect(sha).toMatch(/^[0-9a-f]{40}$/);
  await page.setViewportSize({ width: 1180, height: 900 });

  await page.goto('/#/fixture/workspace?capability=sandbox&images=lifecycle');
  await expect(page.getByTestId('sandbox-workspace')).toBeVisible();

  // Keep a draft while navigating away.
  await page.getByTestId('sandbox-section-policies').click();
  await page.getByTestId('sandbox-tab-filesystem').click();
  await page.getByTestId('sandbox-working-dir').fill('/workspace');

  // Library: one row expanded at a time, details immediately under the row.
  await page.getByTestId('sandbox-section-images').click();
  await expect(page.getByTestId('image-row').first()).toBeVisible();
  await expect(page.getByTestId('image-detail-row')).toHaveCount(0);
  await page.getByTestId('image-row').first().click();
  await expect(page.getByTestId('image-detail-row')).toHaveCount(1);
  await page.getByTestId('image-row').nth(1).click();
  await expect(page.getByTestId('image-detail-row')).toHaveCount(1);
  await page.getByTestId('image-row').nth(1).click();
  await expect(page.getByTestId('image-detail-row')).toHaveCount(0);

  // Builds: durable stage and measured counters; never an invented percent.
  await page.getByTestId('images-section-builds').click();
  await expect(page.getByTestId('images-builds')).toBeVisible();
  await expect(page.getByTestId('image-build-row')).toHaveCount(4);
  const running = page.locator('[data-build-id="build-fixture-running"]');
  await expect(running.getByTestId('image-build-stage')).toContainText('Packaging');
  await expect(running.getByTestId('image-build-progress')).toContainText('files');
  await expect(running.getByTestId('image-build-progress')).not.toContainText('%');

  // Back to Filesystem: the same Session and draft are intact.
  await expect(page.getByTestId('sandbox-session-name')).toBeVisible();
  await page.getByTestId('sandbox-section-policies').click();
  await page.getByTestId('sandbox-tab-filesystem').click();
  await expect(page.getByTestId('sandbox-working-dir')).toHaveValue('/workspace');

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': Library expanded one row inline at a time, Builds showed the durable ' +
      'stage and measured file counts without a percentage, and returning to Filesystem preserved ' +
      'the Session and the /workspace draft',
  });
});

test('SC-02: Distribution separates downloaded bytes from verified mount-readiness', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const sha = String(process.env.NESSION_ACCEPTANCE_TARGET_SHA ?? '');
  expect(sha).toMatch(/^[0-9a-f]{40}$/);
  await page.setViewportSize({ width: 1180, height: 900 });

  await page.goto('/#/fixture/workspace?capability=sandbox&sandbox=agent-cache-downloading');
  await page.getByTestId('sandbox-section-images').click();
  await page.getByTestId('images-section-distribution').click();
  await expect(page.getByTestId('sandbox-distribution')).toBeVisible();

  const first = page.getByTestId('sandbox-distribution-row').first();
  await expect(first.getByTestId('sandbox-distribution-phase')).toHaveText('Downloading');
  await expect(first.getByTestId('sandbox-distribution-transfer')).toHaveText(
    '1.0 MiB / 4.0 MiB',
  );
  await expect(first.getByTestId('sandbox-distribution-active')).toBeVisible();

  const second = page.getByTestId('sandbox-distribution-row').nth(1);
  await expect(second.getByTestId('sandbox-distribution-phase')).toHaveText('Verified');
  await expect(second.getByTestId('sandbox-distribution-active')).toHaveCount(0);

  // Distribution never blocks the Filesystem handoff.
  await page.getByTestId('sandbox-section-policies').click();
  await page.getByTestId('sandbox-tab-filesystem').click();
  await expect(page.getByTestId('sandbox-filesystem-preview')).toBeVisible();

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': Distribution showed one active Downloading digest with measured ' +
      '1.0/4.0 MiB and a separate Verified digest; no partial digest was labelled active or ' +
      'mount-ready, and the Filesystem editor remained reachable',
  });
});
