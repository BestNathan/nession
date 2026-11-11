// #3138 SC-02 (Web half): on the real production fixture at 1440/1180/1024,
// Project Detail and Sandbox Inside resolve the ResourceDetail roles, Project
// Settings and Sandbox Outside resolve the ConfigurationForm/OperationSurface
// roles, corresponding parts agree across the two independent consumers, a
// read-only fact keeps no input chrome, controls/actions sit on the approved
// band, and no state produces page-level horizontal overflow.
//
// Expected values come from design/generated/contracts.json (role tokens and
// the control band); this spec contains no second copy of the typography.
import { expect, test, type Page } from '@playwright/test';
import { freezeFixtureClock } from '../../../../helpers/fixtureVisual';
import {
  captureRecipeTypography,
  expectActionOrder,
  expectControlBand,
  expectDistinctActionEmphasis,
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
const OPERATION = 'pattern.operation-surface';

function canonicalViewport(experience: 'web' | 'app', width: number) {
  const row = loadContracts().viewports.find(
    (item) => item.experience === experience && item.width === width,
  );
  if (row === undefined) {
    throw new Error(`canonical ${experience} viewport ${width} is missing from design/contracts/viewports.json`);
  }
  return row;
}

async function openWebProject(page: Page) {
  await page.goto('/#/fixture?projects=canonical');
  await page.getByTestId('project-item-row').first().click();
  const detail = page.getByTestId('project-detail');
  await expect(detail).toHaveAttribute('data-recipe', 'resource-detail');
  return detail;
}

test('SC-02: Project and Sandbox share the approved Web visual recipes', async ({ page }) => {
  test.setTimeout(110_000);
  verifiedRuntime('SC-02');
  await freezeFixtureClock(page);

  for (const width of [1440, 1180, 1024]) {
    const viewport = canonicalViewport('web', width);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const base = { experience: 'web' as const, viewport: viewport.id };
    const detailOpts = { ...base, pattern: DETAIL };
    const formOpts = { ...base, pattern: FORM };
    const operationOpts = { ...base, pattern: OPERATION };

    // ── Project Detail ──
    const detail = await openWebProject(page);
    await expectRecipeRole(detail.locator('[data-recipe-part="detail-title"]').first(), {
      ...detailOpts,
      part: 'detail-title',
    });
    const projectSection = detail.locator('[data-recipe-part="detail-section-title"]').first();
    await expectRecipeRole(projectSection, { ...detailOpts, part: 'detail-section-title' });
    const projectFactLabel = detail.locator('[data-recipe-part="detail-fact-label"]').first();
    await expectRecipeRole(projectFactLabel, { ...detailOpts, part: 'detail-fact-label' });
    await expectRecipeRole(detail.locator('[data-recipe-part="detail-fact-value"]').first(), {
      ...detailOpts,
      part: 'detail-fact-value',
    });
    await expectReadOnlyFacts(detail, detailOpts);
    await expectNoPageOverflow(page, detailOpts);
    const projectSectionStyle = await captureRecipeTypography(projectSection);
    const projectFactLabelStyle = await captureRecipeTypography(projectFactLabel);

    // ── Sandbox Inside: the same hierarchy, independently mounted ──
    await page.goto('/#/fixture/workspace?capability=sandbox&sandbox=inside');
    const inside = page.getByTestId('sandbox-inside');
    await expect(inside).toBeVisible();
    await expectRecipeRole(inside.locator('[data-recipe-part="detail-title"]').first(), {
      ...detailOpts,
      part: 'detail-title',
    });
    const insideSection = inside.locator('[data-recipe-part="detail-section-title"]').first();
    await expectRecipeRole(insideSection, { ...detailOpts, part: 'detail-section-title' });
    await expectSameRecipeTypography(projectSectionStyle, insideSection, {
      ...detailOpts,
      part: 'detail-section-title',
    });
    const insideFactLabel = inside.locator('[data-recipe-part="detail-fact-label"]').first();
    await expectRecipeRole(insideFactLabel, { ...detailOpts, part: 'detail-fact-label' });
    await expectSameRecipeTypography(projectFactLabelStyle, insideFactLabel, {
      ...detailOpts,
      part: 'detail-fact-label',
    });
    await expectReadOnlyFacts(inside, detailOpts);
    await expectNoPageOverflow(page, detailOpts);

    // ── Project Settings: OperationSurface + ConfigurationForm ──
    await openWebProject(page);
    await page.getByTestId('project-detail-settings').click();
    const settings = page.getByTestId('project-settings-dialog');
    await expect(settings).toHaveAttribute('data-recipe', 'operation-surface');
    await expectRecipeRole(settings.locator('[data-recipe-part="operation-title"]'), {
      ...operationOpts,
      part: 'operation-title',
    });
    const projectFormSection = settings.locator('[data-recipe-part="form-section-title"]').first();
    await expectRecipeRole(projectFormSection, { ...formOpts, part: 'form-section-title' });
    const projectFormHelp = settings.locator('[data-recipe-part="form-help"]').first();
    await expectRecipeRole(projectFormHelp, { ...formOpts, part: 'form-help' });
    const projectFormLabel = settings.locator('[data-recipe-part="form-label"]').first();
    await expectControlBand(settings.locator('#project-settings-name'), formOpts);
    await expectGridColumns(
      settings.locator('[data-recipe-part="form-grid"]').first(),
      2,
      formOpts,
    );
    const cancel = settings.getByRole('button', { name: 'Cancel' });
    const save = settings.getByTestId('project-settings-submit');
    await expectControlBand(cancel, formOpts);
    await expectControlBand(save, formOpts);
    await expectActionOrder(cancel, save, operationOpts);
    await expectDistinctActionEmphasis(cancel, save, operationOpts);
    await expectNoPageOverflow(page, formOpts);
    const projectFormSectionStyle = await captureRecipeTypography(projectFormSection);
    const projectFormHelpStyle = await captureRecipeTypography(projectFormHelp);
    const projectFormLabelStyle = await captureRecipeTypography(projectFormLabel);

    // ── Sandbox Outside: the same form grammar, independently mounted ──
    await page.goto('/#/fixture/workspace?capability=sandbox');
    const composer = page.getByTestId('sandbox-composer');
    await expect(composer).toBeVisible();
    await page.getByTestId('sandbox-tab-filesystem').click();
    const sandboxForm = composer.locator('[data-recipe="configuration-form"]').first();
    const sandboxSection = sandboxForm.locator('[data-recipe-part="form-section-title"]').first();
    await expectRecipeRole(sandboxSection, { ...formOpts, part: 'form-section-title' });
    await expectSameRecipeTypography(projectFormSectionStyle, sandboxSection, {
      ...formOpts,
      part: 'form-section-title',
    });
    const sandboxHelp = sandboxForm.locator('[data-recipe-part="form-help"]').first();
    await expectRecipeRole(sandboxHelp, { ...formOpts, part: 'form-help' });
    await expectSameRecipeTypography(projectFormHelpStyle, sandboxHelp, {
      ...formOpts,
      part: 'form-help',
    });
    const sandboxLabel = sandboxForm.locator('[data-recipe-part="form-label"]').first();
    await expectSameRecipeTypography(projectFormLabelStyle, sandboxLabel, {
      ...formOpts,
      part: 'form-label',
    });
    await expectControlBand(page.getByTestId('sandbox-working-dir'), formOpts);
    await expectNoPageOverflow(page, formOpts);
  }
});
