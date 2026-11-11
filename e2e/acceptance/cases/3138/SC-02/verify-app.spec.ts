// #3138 SC-02 (App half): at 390/375/844×390 the App keeps one host
// page header per depth, a stacked touch hierarchy, the App's own density of
// the shared detail/form roles, read-only facts without input chrome, and no
// page-level horizontal overflow. Project and Sandbox are independent
// consumers of the same recipes, so their corresponding parts are compared
// with each other as well as against the contract.
import { expect, test, type Page } from '@playwright/test';
import { freezeFixtureClock } from '../../../../helpers/fixtureVisual';
import {
  captureRecipeTypography,
  expectControlBand,
  expectGridColumns,
  expectNoPageOverflow,
  expectReadOnlyFacts,
  expectRecipeRole,
  expectSameRecipeTypography,
} from '../../../../helpers/ui-assert/assertions';
import { loadContracts } from '../../../../helpers/ui-assert/contracts';
import { verifiedRuntime } from '../../../shared/foreground-resume-browser.cjs';

const DETAIL = 'pattern.resource-detail';
const FORM = 'pattern.configuration-form';

function canonicalViewport(experience: 'web' | 'app', width: number) {
  const row = loadContracts().viewports.find(
    (item) => item.experience === experience && item.width === width,
  );
  if (row === undefined) {
    throw new Error(`canonical ${experience} viewport ${width} is missing from design/contracts/viewports.json`);
  }
  return row;
}

async function openAppProject(page: Page) {
  await page.goto('/#/fixture/app?projects=canonical');
  await page.reload();
  await page.getByTestId('app-layer-root').waitFor();
  await page.getByTestId('app-header-sessions').first().click();
  await page.getByTestId('project-item-row').first().click();
  const detail = page.getByTestId('app-project-detail');
  await expect(detail).toBeVisible();
  return detail;
}

async function openAppSandbox(page: Page, search = '') {
  await page.goto(`/#/fixture/app${search}`);
  await page.reload();
  await page.getByTestId('app-layer-root').waitFor();
  await page.getByTestId('app-header-workspace').click();
  await page.getByTestId('workspace-tool-sandbox').click();
  const workspace = page.getByTestId('sandbox-workspace');
  await expect(workspace).toBeVisible();
  return workspace;
}

test('SC-02: the App keeps one header, stacked controls and the App roles', async ({ page }) => {
  test.setTimeout(110_000);
  verifiedRuntime('SC-02');
  await freezeFixtureClock(page);

  for (const width of [390, 375, 844]) {
    const viewport = canonicalViewport('app', width);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const base = { experience: 'app' as const, viewport: viewport.id };
    const detailOpts = { ...base, pattern: DETAIL };
    const formOpts = { ...base, pattern: FORM };

    // ── Project Detail: the host header owns the name ──
    const detail = await openAppProject(page);
    await expect(detail.getByTestId('app-page-header')).toHaveCount(1);
    await expect(page.getByTestId('project-detail-title')).toHaveCount(1);
    await expect(detail.locator('[data-recipe-part="detail-title"]')).toHaveCount(0);
    const appDetail = page.getByTestId('project-detail');
    const appSection = appDetail.locator('[data-recipe-part="detail-section-title"]').first();
    await expectRecipeRole(appSection, { ...detailOpts, part: 'detail-section-title' });
    const appFactLabel = appDetail.locator('[data-recipe-part="detail-fact-label"]').first();
    await expectRecipeRole(appFactLabel, { ...detailOpts, part: 'detail-fact-label' });
    await expectRecipeRole(appDetail.locator('[data-recipe-part="detail-fact-value"]').first(), {
      ...detailOpts,
      part: 'detail-fact-value',
    });
    await expectReadOnlyFacts(appDetail, detailOpts);
    await expectNoPageOverflow(page, detailOpts);
    const appSectionStyle = await captureRecipeTypography(appSection);
    const appFactLabelStyle = await captureRecipeTypography(appFactLabel);

    // ── Project Create: one header, stacked fields on the touch band ──
    await page.getByTestId('app-page-back').click();
    await expect(page.getByTestId('app-sessions-surface')).toBeVisible();
    await page.getByTestId('project-create').click();
    const create = page.getByTestId('app-project-create-page');
    await expect(create).toBeVisible();
    await expect(create.getByTestId('app-page-header')).toHaveCount(1);
    const appFormSection = create.locator('[data-recipe-part="form-section-title"]').first();
    await expectRecipeRole(appFormSection, { ...formOpts, part: 'form-section-title' });
    const appFormHelp = create.locator('[data-recipe-part="form-help"]').first();
    await expectRecipeRole(appFormHelp, { ...formOpts, part: 'form-help' });
    await expectControlBand(create.locator('#project-create-name'), formOpts);
    await expectControlBand(create.getByTestId('project-create-submit'), formOpts);
    await expectGridColumns(create.locator('[data-recipe-part="form-grid"]').first(), 1, formOpts);
    await expectNoPageOverflow(page, formOpts);
    const appFormSectionStyle = await captureRecipeTypography(appFormSection);
    const appFormHelpStyle = await captureRecipeTypography(appFormHelp);

    // ── Settings: one header, Back as the only leave ──
    await create.getByTestId('app-page-back').click();
    await expect(page.getByTestId('app-sessions-surface')).toBeVisible();
    await page.getByTestId('project-item-row').first().click();
    await page.getByTestId('project-detail-settings').click();
    const settings = page.getByTestId('app-project-settings-page');
    await expect(settings).toBeVisible();
    await expect(settings.getByTestId('app-page-header')).toHaveCount(1);
    const settingsSection = settings.locator('[data-recipe-part="form-section-title"]').first();
    await expectRecipeRole(settingsSection, { ...formOpts, part: 'form-section-title' });
    await expectSameRecipeTypography(appFormSectionStyle, settingsSection, {
      ...formOpts,
      part: 'form-section-title',
    });
    await expectControlBand(settings.locator('#project-settings-name'), formOpts);
    await expectControlBand(settings.getByTestId('project-settings-submit'), formOpts);
    await expectNoPageOverflow(page, formOpts);

    // ── Sandbox Outside: the same form roles, one host header ──
    await openAppSandbox(page);
    await expect(
      page.getByTestId('app-layer-workspace').getByTestId('app-page-header'),
    ).toHaveCount(1);
    await page.getByTestId('sandbox-tab-filesystem').click();
    const sandboxForm = page
      .getByTestId('sandbox-composer')
      .locator('[data-recipe="configuration-form"]')
      .first();
    const sandboxSection = sandboxForm.locator('[data-recipe-part="form-section-title"]').first();
    await expectRecipeRole(sandboxSection, { ...formOpts, part: 'form-section-title' });
    await expectSameRecipeTypography(appFormSectionStyle, sandboxSection, {
      ...formOpts,
      part: 'form-section-title',
    });
    const sandboxHelp = sandboxForm.locator('[data-recipe-part="form-help"]').first();
    await expectSameRecipeTypography(appFormHelpStyle, sandboxHelp, {
      ...formOpts,
      part: 'form-help',
    });
    await expectControlBand(page.getByTestId('sandbox-working-dir'), formOpts);
    await expectGridColumns(
      sandboxForm.locator('[data-recipe-part="form-grid"]').first(),
      1,
      formOpts,
    );
    await expectNoPageOverflow(page, formOpts);

    // ── Sandbox Inside: observed facts with no input chrome ──
    await openAppSandbox(page, '?sandbox=inside');
    await expect(
      page.getByTestId('app-layer-workspace').getByTestId('app-page-header'),
    ).toHaveCount(1);
    const inside = page.getByTestId('sandbox-inside');
    const insideSection = inside.locator('[data-recipe-part="detail-section-title"]').first();
    await expectRecipeRole(insideSection, { ...detailOpts, part: 'detail-section-title' });
    await expectSameRecipeTypography(appSectionStyle, insideSection, {
      ...detailOpts,
      part: 'detail-section-title',
    });
    const insideFactLabel = inside.locator('[data-recipe-part="detail-fact-label"]').first();
    await expectRecipeRole(insideFactLabel, { ...detailOpts, part: 'detail-fact-label' });
    await expectSameRecipeTypography(appFactLabelStyle, insideFactLabel, {
      ...detailOpts,
      part: 'detail-fact-label',
    });
    await expectReadOnlyFacts(inside, detailOpts);
    await expectNoPageOverflow(page, detailOpts);
  }
});
