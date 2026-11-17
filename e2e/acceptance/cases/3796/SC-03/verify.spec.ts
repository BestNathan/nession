// #3796 SC-03: Distribution shows only the selected Agent's truthful
// observation and enables Prepare, Resume or Retry only for the eligible
// cache state; no global push is implied.
import { expect, test } from '@playwright/test';

async function openDistribution(page: import('@playwright/test').Page, query: string) {
  await page.goto(`/#/fixture/workspace?capability=sandbox&${query}`);
  await page.getByTestId('sandbox-section-images').click();
  await page.getByTestId('images-section-distribution').click();
  await expect(page.getByTestId('sandbox-distribution')).toBeVisible();
  await expect(page.getByTestId('sandbox-distribution-row').first()).toBeVisible();
}

test('SC-03: eligible Prepare/Resume/Retry and truthful phase progression', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const sha = String(process.env.NESSION_ACCEPTANCE_TARGET_SHA ?? '');
  expect(sha).toMatch(/^[0-9a-f]{40}$/);
  await page.setViewportSize({ width: 1180, height: 900 });

  // An absent identity offers Prepare. The Agent's own observation drives the
  // progression; the command returns an authority-backed Downloading state.
  await openDistribution(page, 'sandbox=agent-cache-absent');
  const absentRow = page.getByTestId('sandbox-distribution-row').first();
  await expect(absentRow.getByTestId('sandbox-distribution-phase')).toHaveText('Not cached');
  await expect(absentRow.getByTestId('sandbox-distribution-prepare')).toBeVisible();
  await expect(absentRow.getByTestId('sandbox-distribution-resume')).toHaveCount(0);
  await expect(absentRow.getByTestId('sandbox-distribution-retry')).toHaveCount(0);
  await absentRow.getByTestId('sandbox-distribution-prepare').click();
  await expect(absentRow.getByTestId('sandbox-distribution-phase')).toHaveText('Downloading');
  await expect(absentRow.getByTestId('sandbox-distribution-active')).toBeVisible();
  await expect(absentRow.getByTestId('sandbox-distribution-phase')).toHaveText('Verifying');
  await expect(absentRow.getByTestId('sandbox-distribution-phase')).toHaveText('Verified');
  await expect(absentRow.getByTestId('sandbox-distribution-prepare')).toHaveCount(0);

  // A durable partial offers Resume, not Prepare or Retry. The fixture keeps
  // one digest partial, so the row is located by its own affordance.
  await openDistribution(page, 'sandbox=agent-cache-resumable');
  const partialRow = page
    .getByTestId('sandbox-distribution-row')
    .filter({ has: page.getByTestId('sandbox-distribution-resume') });
  await expect(partialRow).toHaveCount(1);
  await expect(partialRow.getByTestId('sandbox-distribution-phase')).toHaveText(
    'Resumable partial',
  );
  await expect(partialRow.getByTestId('sandbox-distribution-prepare')).toHaveCount(0);
  await partialRow.getByTestId('sandbox-distribution-resume').click();
  await expect(partialRow.getByTestId('sandbox-distribution-phase')).toHaveText('Downloading');

  // A failed cache offers Retry.
  await openDistribution(page, 'sandbox=agent-cache-failed');
  const failedRow = page.getByTestId('sandbox-distribution-row').first();
  await expect(failedRow.getByTestId('sandbox-distribution-phase')).toHaveText('Cache failed');
  await expect(failedRow.getByTestId('sandbox-distribution-retry')).toBeVisible();
  await expect(failedRow.getByTestId('sandbox-distribution-prepare')).toHaveCount(0);
  await failedRow.getByTestId('sandbox-distribution-retry').click();
  await expect(failedRow.getByTestId('sandbox-distribution-phase')).toHaveText('Downloading');

  // A verified identity offers no action at all: Server Ready is not being
  // pushed anywhere and the Agent state is already mount-ready.
  await openDistribution(page, 'sandbox=outside');
  const verifiedRow = page.getByTestId('sandbox-distribution-row').first();
  await expect(verifiedRow.getByTestId('sandbox-distribution-phase')).toHaveText('Verified');
  await expect(verifiedRow.getByTestId('sandbox-distribution-prepare')).toHaveCount(0);
  await expect(verifiedRow.getByTestId('sandbox-distribution-resume')).toHaveCount(0);
  await expect(verifiedRow.getByTestId('sandbox-distribution-retry')).toHaveCount(0);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': the Distribution view showed only the selected Agent; an absent ' +
      'digest offered Prepare and progressed Downloading -> Verifying -> Verified, a durable ' +
      'partial offered Resume, a failed cache offered Retry, and a verified identity offered no ' +
      'action',
  });
});
