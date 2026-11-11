// #3298 SC-04: the existing shared `overlay-system-3142` mock was revised in
// place. The trusted Pages manifest binds the published artifact to the pinned
// prototype source SHA; Chromium walks the corrected three-zone comparison,
// the legacy approximation, long/many-row scrolling, App roles and disabled/
// error states. Mock evidence only — production proof is SC-01..03.
import { expect, test } from '@playwright/test';
import { verifiedRuntime } from '../../../shared/foreground-resume-browser.cjs';

const PROTOTYPE_SHA = '6dbcc2a3fad8a0f59b6dc7f4dcb72e832f1f573d';
const MANIFEST_URL = 'https://bestnathan.github.io/nession/prototypes/manifest.json';
const PROTOTYPE_URL =
  'https://bestnathan.github.io/nession/prototypes/overlay-system-3142/index.html';

test('SC-04: the published mock revision proves the three-zone comparison', async ({ page }) => {
  test.setTimeout(110_000);
  const { sha } = verifiedRuntime('SC-04');
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  const manifestResponse = await page.request.get(MANIFEST_URL);
  expect(manifestResponse.ok()).toBe(true);
  const manifest = (await manifestResponse.json()) as {
    source?: { branch?: string; sha?: string };
    entries?: Array<{ slug?: string; preview?: string; source?: string }>;
  };
  expect(manifest.source?.branch).toBe('prototype');
  expect(manifest.source?.sha).toBe(PROTOTYPE_SHA);
  const entry = (manifest.entries ?? []).find((item) => item.slug === 'overlay-system-3142');
  expect(entry).toBeDefined();
  expect(entry!.preview).toBe('prototypes/overlay-system-3142/index.html');
  expect(entry!.source).toContain(`/blob/${PROTOTYPE_SHA}/overlay-system-3142/index.html`);

  await page.goto(PROTOTYPE_URL);
  const product = page.locator('#nession-product');
  await expect(product).toBeVisible();
  await expect(product).toHaveAttribute('data-experience', 'web');
  const report = page.locator('[data-anatomy-report]');
  const sourceLink = page.locator('[data-nession-source-link]');
  await expect(sourceLink).toHaveAttribute('href', /github\.com\/BestNathan\/nession/);
  await expect(page.locator('a[href*="/issues/3298"]').first()).toBeVisible();

  await page.locator('[data-fixture="long"]').click();
  await page.locator('[data-anatomy-mode="fixed"]').click();
  await product.locator('.entry [data-action="project"]').click();
  const dialog = product.locator('.dialog.wide');
  await expect(dialog).toBeVisible();
  await expect(product.locator('.loc-row')).toHaveCount(8);
  await expect(report).toHaveAttribute('data-geometry', 'pass');
  await expect(report).toContainText('Header full width: yes');
  await expect(report).toContainText('Footer flush: yes');
  await expect(report).toContainText('Scroll owner: Body');

  // Top → Middle → Bottom: corrected header/footer geometry stays put.
  const dialogBefore = await dialog.boundingBox();
  const headerBefore = await dialog.locator('.dialog-head').boundingBox();
  const footerBefore = await dialog.locator('.dialog-foot').boundingBox();
  const headerOffset = (headerBefore?.y ?? 0) - (dialogBefore?.y ?? 0);
  const footerBottomOffset =
    (footerBefore?.y ?? 0) + (footerBefore?.height ?? 0) -
    ((dialogBefore?.y ?? 0) + (dialogBefore?.height ?? 0));
  for (const position of ['start', 'middle', 'end']) {
    await page.locator(`[data-anatomy-scroll="${position}"]`).click();
    await expect(report).toHaveAttribute('data-geometry', 'pass');
    const dialogNow = await dialog.boundingBox();
    const headerNow = await dialog.locator('.dialog-head').boundingBox();
    const footerNow = await dialog.locator('.dialog-foot').boundingBox();
    // The control clicks may scroll the surrounding documentation page; compare
    // offsets inside the product surface, not absolute viewport coordinates.
    expect((headerNow?.y ?? 0) - (dialogNow?.y ?? 0)).toBeCloseTo(headerOffset, 0);
    expect(
      (footerNow?.y ?? 0) + (footerNow?.height ?? 0) -
      ((dialogNow?.y ?? 0) + (dialogNow?.height ?? 0)),
    ).toBeCloseTo(footerBottomOffset, 0);
  }

  // The legacy approximation intentionally models the faulty anatomy; the
  // report must distinguish it from the corrected contract.
  await page.locator('[data-anatomy-mode="legacy"]').click();
  await expect(report).toHaveAttribute('data-geometry', 'review');
  await expect(report).toContainText('Scroll owner: Dialog');
  await page.locator('[data-anatomy-mode="fixed"]').click();
  await expect(report).toHaveAttribute('data-geometry', 'pass');

  // App 390: the operation keeps one full-height surface and the corrected
  // three zones; the mock reports the same pass.
  await page.locator('[data-np-size="390"][data-np-experience="app"]').click();
  await expect(product).toHaveAttribute('data-experience', 'app');
  await product.locator('.entry [data-action="project"]').click();
  const appDialog = product.locator('.dialog.fullscreen');
  await expect(appDialog).toBeVisible();
  await expect(appDialog.locator('.dialog-head')).toHaveCount(1);
  await expect(report).toHaveAttribute('data-geometry', 'pass');
  await page.keyboard.press('Escape');
  await expect(product.locator('.dialog')).toHaveCount(0);
  await page.locator('[data-np-size="1180"][data-np-experience="web"]').click();
  await expect(product).toHaveAttribute('data-experience', 'web');

  // Offline/invalid fixtures keep the error readable and the primary disabled.
  for (const fixture of ['invalid', 'offline']) {
    await page.locator(`[data-fixture="${fixture}"]`).click();
    await product.locator('.entry [data-action="session"]').click();
    const stateDialog = product.locator('.dialog.standard');
    await expect(stateDialog).toBeVisible();
    await expect(stateDialog.locator('.error')).toBeVisible();
    await expect(stateDialog.locator('.dialog-foot .btn.primary')).toBeDisabled();
    await page.keyboard.press('Escape');
  }
  expect(pageErrors, 'the published mock must not throw').toEqual([]);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': manifest sources overlay-system-3142 at prototype ' +
      PROTOTYPE_SHA + '; Chromium walked Web corrected/legacy comparison at top/middle/bottom' +
      ' (Header full width / Footer flush / Body scroll), App 390, and invalid/offline states',
  });
});
