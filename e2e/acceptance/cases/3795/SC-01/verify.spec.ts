// #3795 SC-01: the Build editor exposes only the source adapters the Server
// actually serves, validates each source shape before submitting a durable
// job, and distinguishes flattened from referenced Compose output.
import { expect, test } from '@playwright/test';

test('SC-01: supported Build adapters, source validation and Compose output', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const sha = String(process.env.NESSION_ACCEPTANCE_TARGET_SHA ?? '');
  expect(sha).toMatch(/^[0-9a-f]{40}$/);
  await page.setViewportSize({ width: 1180, height: 900 });

  await page.goto('/#/fixture/workspace?capability=sandbox');
  await page.getByTestId('sandbox-section-images').click();
  await page.getByTestId('images-section-builds').click();
  await expect(page.getByTestId('image-build-form')).toBeVisible();

  // Only the three Server Build Source kinds are offered. Archive and OCI
  // conversion exist below the Server source DTO, so they are not choices.
  await expect(page.getByTestId('image-build-source-github')).toBeVisible();
  await expect(page.getByTestId('image-build-source-local_directory')).toBeVisible();
  await expect(page.getByTestId('image-build-source-compose')).toBeVisible();
  await expect(page.getByTestId('image-build-source-archive')).toHaveCount(0);
  await expect(page.getByTestId('image-build-source-oci')).toHaveCount(0);

  // An invalid GitHub declaration is refused inline and never reaches the
  // durable build flow.
  await page.getByTestId('image-build-repository').fill('https://gitlab.com/owner/repo');
  await page.getByTestId('image-build-ref').fill('');
  await page.getByTestId('image-build-submit').click();
  await expect(page.getByTestId('image-build-error-repository-url')).toBeVisible();
  await expect(page.getByTestId('image-build-error-ref')).toBeVisible();
  await expect(page.getByTestId('image-build-row')).toHaveCount(0);

  // The Directory adapter checks the path shape locally; the Server still
  // authorizes the operator-configured root.
  await page.getByTestId('image-build-source-local_directory').click();
  await page.getByTestId('image-build-path').fill('relative/path');
  await page.getByTestId('image-build-submit').click();
  await expect(page.getByTestId('image-build-error-path')).toBeVisible();
  await expect(page.getByTestId('image-build-row')).toHaveCount(0);

  await page.getByTestId('image-build-path').fill('/srv/nession/sources/base');
  await page.getByTestId('image-build-submit').click();
  await expect(
    page.getByTestId('image-build-row').filter({ hasText: '/srv/nession/sources/base' }),
  ).toBeVisible();

  // Referenced Compose keeps every source at the composed root; choosing it
  // hides the destination field instead of submitting a refused declaration.
  await page.getByTestId('image-build-source-compose').click();
  await page.getByTestId('image-build-compose-repository').first().fill('base');
  await page.getByTestId('image-build-compose-ref').first().fill('latest');
  await page.getByTestId('image-build-compose-destination').first().fill('/opt/base');
  await page.getByTestId('image-build-representation-referenced').click();
  await expect(page.getByTestId('image-build-compose-destination')).toHaveCount(0);
  await page.getByTestId('image-build-submit').click();
  await expect(
    page.getByTestId('image-build-row').filter({ hasText: 'compose (Referenced)' }),
  ).toBeVisible();

  // Flattened Compose validates destinations and records both sources.
  await page.getByTestId('image-build-source-compose').click();
  await page.getByTestId('image-build-compose-repository').first().fill('base');
  await page.getByTestId('image-build-compose-ref').first().fill('latest');
  await page.getByTestId('image-build-compose-destination').first().fill('/');
  await page.getByTestId('image-build-compose-add').click();
  await page.getByTestId('image-build-compose-repository').nth(1).fill('tools');
  await page.getByTestId('image-build-compose-ref').nth(1).fill('v1');
  await page.getByTestId('image-build-compose-destination').nth(1).fill('/opt/tools');
  await page.getByTestId('image-build-submit').click();
  const flat = page
    .getByTestId('image-build-row')
    .filter({ hasText: 'compose (Flattened)' })
    .filter({ hasText: 'tools@v1 -> /opt/tools' });
  await expect(flat).toBeVisible();

  // An overlapping flat destination is refused before submission.
  const before = await page.getByTestId('image-build-row').count();
  await page.getByTestId('image-build-source-compose').click();
  await page.getByTestId('image-build-compose-repository').first().fill('base');
  await page.getByTestId('image-build-compose-ref').first().fill('latest');
  await page.getByTestId('image-build-compose-destination').first().fill('/opt');
  await page.getByTestId('image-build-compose-add').click();
  await page.getByTestId('image-build-compose-repository').nth(1).fill('tools');
  await page.getByTestId('image-build-compose-ref').nth(1).fill('v1');
  await page.getByTestId('image-build-compose-destination').nth(1).fill('/opt/tools');
  await page.getByTestId('image-build-submit').click();
  await expect(page.getByTestId('image-build-error-compose')).toContainText('overlap');
  await expect(page.getByTestId('image-build-row')).toHaveCount(before);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': the Build editor offered GitHub, Directory and Compose only; ' +
      'invalid GitHub, relative Directory and overlapping Compose destinations produced inline ' +
      'errors without creating a durable build row; a referenced Compose submitted at the root ' +
      'and a two-source flattened Compose with /opt/tools rendered distinct source output',
  });
});
