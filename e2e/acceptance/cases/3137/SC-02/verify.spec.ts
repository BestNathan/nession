// #3137 SC-02: on real Web Chromium fixtures at 1440/1180/1024, Project Detail
// and Sandbox Inside share the ResourceDetail roles while Project Settings and
// Sandbox Outside share the ConfigurationForm roles. Corresponding roles must
// resolve the same computed typography and material relationships; read-only
// facts must not borrow input chrome; actions keep one primary at the control
// band; long content never produces page-level horizontal overflow.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { freezeFixtureClock } from '../../../../helpers/fixtureVisual';
import { verifiedRuntime } from '../../../shared/foreground-resume-browser.cjs';

const STYLE_KEYS = ['fontSize', 'fontWeight', 'lineHeight', 'color', 'fontFamily'] as const;

async function computed(locator: Locator): Promise<Record<string, string>> {
  return locator.evaluate((element, keys) => {
    const style = getComputedStyle(element);
    return Object.fromEntries(keys.map((key) => [key, style[key as keyof CSSStyleDeclaration] as string]));
  }, STYLE_KEYS as unknown as string[]);
}

function expectSameRole(actual: Record<string, string>, expected: Record<string, string>): void {
  for (const key of STYLE_KEYS) {
    expect(actual[key], key).toBe(expected[key]);
  }
}

async function settledHeight(locator: Locator, expected: number): Promise<void> {
  await expect
    .poll(async () => Math.round((await locator.boundingBox())?.height ?? -1))
    .toBe(expected);
}

async function expectNoPageOverflow(page: Page): Promise<void> {
  const difference = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(difference, 'page-level horizontal overflow').toBeLessThanOrEqual(1);
}

async function openProject(page: Page): Promise<Locator> {
  await page.goto('/#/fixture?projects=canonical');
  await page.getByTestId('project-item-row').first().click();
  const detail = page.getByTestId('project-detail');
  await expect(detail).toHaveAttribute('data-recipe', 'resource-detail');
  await expect(detail.getByTestId('project-detail-title')).toBeVisible();
  return detail;
}

async function openSandbox(page: Page, query = ''): Promise<Locator> {
  await page.goto(`/#/fixture/workspace?capability=sandbox${query}`);
  const workspace = page.getByTestId('sandbox-workspace');
  await expect(workspace).toBeVisible();
  return workspace;
}

test('SC-02: Project and Sandbox share detail/form roles on Web', async ({ page }) => {
  test.setTimeout(110_000);
  verifiedRuntime('SC-02');
  await freezeFixtureClock(page);

  const titleByViewport: Record<string, Record<string, string>> = {};
  const sectionByViewport: Record<string, Record<string, string>> = {};
  const factLabelByViewport: Record<string, Record<string, string>> = {};

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1180, height: 900 },
    { width: 1024, height: 768 },
  ]) {
    await page.setViewportSize(viewport);
    const detail = await openProject(page);
    await expectNoPageOverflow(page);

    const title = detail.locator('[data-recipe-part="detail-title"]');
    const section = detail.locator('[data-recipe-part="detail-section-title"]').first();
    const factLabel = detail.locator('[data-recipe-part="detail-fact-label"]').first();
    const factValue = detail.locator('[data-recipe-part="detail-fact-value"]').first();
    const titleStyle = await computed(title);
    const sectionStyle = await computed(section);
    const factLabelStyle = await computed(factLabel);
    const factValueStyle = await computed(factValue);

    expect(titleStyle.fontSize, 'surface title role').toBe('16px');
    expect(titleStyle.fontWeight).toBe('600');
    expect(sectionStyle.fontSize, 'section heading role').toBe('12.5px');
    expect(sectionStyle.fontWeight).toBe('500');
    expect(factLabelStyle.fontSize, 'fact label role').toBe('11px');
    expect(factValueStyle.fontSize, 'fact value role').toBe('12.5px');
    expect(parseFloat(titleStyle.fontSize)).toBeGreaterThan(parseFloat(sectionStyle.fontSize));
    expect(parseFloat(sectionStyle.fontSize)).toBeGreaterThan(parseFloat(factLabelStyle.fontSize));

    // A read-only fact is not a disabled form control or a bordered field.
    const fact = detail.locator('[data-recipe-part="detail-fact"]').first();
    const factChrome = await fact.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        border: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth],
        background: style.backgroundColor,
      };
    });
    expect(factChrome.border).toEqual(['0px', '0px', '0px', '0px']);
    expect(['rgba(0, 0, 0, 0)', 'transparent']).toContain(factChrome.background);
    await expect(detail.locator('input, textarea, select, fieldset')).toHaveCount(0);

    titleByViewport[viewport.width] = titleStyle;
    sectionByViewport[viewport.width] = sectionStyle;
    factLabelByViewport[viewport.width] = factLabelStyle;

    // Sandbox Inside: the same roles, on the capability's observed state.
    await openSandbox(page, '&sandbox=inside');
    await expectNoPageOverflow(page);
    const inside = page.getByTestId('sandbox-inside');
    const insideTitle = inside.locator('[data-recipe-part="detail-title"]');
    const insideSection = inside.locator('[data-recipe-part="detail-section-title"]').first();
    const insideFactLabel = inside.locator('[data-recipe-part="detail-fact-label"]').first();
    const insideDetail = inside.locator('[data-recipe="resource-detail"]').first();
    expectSameRole(await computed(insideTitle), titleStyle);
    expectSameRole(await computed(insideSection), sectionStyle);
    expectSameRole(await computed(insideFactLabel), factLabelStyle);
    await expect(insideDetail.locator('input, textarea, select, fieldset')).toHaveCount(0);
  }

  // Corresponding roles stay identical across the three Web widths.
  for (const width of [1180, 1024] as const) {
    expectSameRole(titleByViewport[width], titleByViewport[1440]);
    expectSameRole(sectionByViewport[width], sectionByViewport[1440]);
    expectSameRole(factLabelByViewport[width], factLabelByViewport[1440]);
  }

  // ── Project Settings: operation title + configuration form roles ──
  await page.setViewportSize({ width: 1440, height: 900 });
  const detail = await openProject(page);
  await detail.getByTestId('project-detail-settings').click();
  const settings = page.getByTestId('project-settings-dialog');
  await expect(settings).toHaveAttribute('data-recipe', 'operation-surface');

  const operationTitle = await computed(settings.locator('[data-recipe-part="operation-title"]'));
  expectSameRole(operationTitle, titleByViewport[1440]);

  const formSection = await computed(
    settings.locator('[data-recipe-part="form-section-title"]').first(),
  );
  expectSameRole(formSection, sectionByViewport[1440]);

  const projectLabel = await computed(settings.locator('[data-recipe-part="form-label"]').first());
  expect(projectLabel.fontSize).toBe('14px');
  expect(projectLabel.fontWeight).toBe('500');

  const projectInput = settings.locator('#project-settings-name');
  // The shared Dialog has an entrance transition; measure the settled band.
  await settledHeight(projectInput, 32);

  const cancel = settings.getByRole('button', { name: 'Cancel' });
  const save = settings.getByTestId('project-settings-submit');
  await settledHeight(cancel, 32);
  await settledHeight(save, 32);
  expect((await cancel.boundingBox())!.x).toBeLessThan((await save.boundingBox())!.x);
  const projectSecondary = await cancel.evaluate((element) => getComputedStyle(element).backgroundColor);
  const projectPrimary = await save.evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(projectSecondary).not.toBe(projectPrimary);
  await expectNoPageOverflow(page);

  // The operation-level error uses the shared destructive semantic.
  await page.keyboard.press('Escape');
  await page.getByTestId('project-create').click();
  const create = page.getByTestId('create-project-dialog');
  await create.getByTestId('project-create-submit').click();
  const projectError = create.getByTestId('project-dialog-error');
  await expect(projectError).toHaveAttribute('data-recipe-part', 'operation-error');
  await expect(projectError).toHaveAttribute('role', 'alert');
  const projectErrorColor = await projectError.evaluate(
    (element) => getComputedStyle(element).color,
  );
  await page.keyboard.press('Escape');

  // ── Sandbox Outside: the same operation/form roles ──
  await openSandbox(page);
  const composer = page.getByTestId('sandbox-composer');
  await expect(composer.locator('[data-recipe="resource-detail"]').first()).toBeVisible();

  const outsideTitle = await computed(
    composer.locator('[data-recipe-part="detail-title"]').first(),
  );
  expectSameRole(outsideTitle, titleByViewport[1440]);

  await page.getByTestId('sandbox-tab-filesystem').click();
  const formSurface = composer.locator('[data-recipe="configuration-form"]').first();
  await expect(formSurface).toBeVisible();
  const sandboxSection = await computed(
    formSurface.locator('[data-recipe-part="form-section-title"]').first(),
  );
  expectSameRole(sandboxSection, sectionByViewport[1440]);
  const sandboxLabel = await computed(
    formSurface.locator('[data-recipe-part="form-label"]').first(),
  );
  expectSameRole(sandboxLabel, projectLabel);
  const sandboxInputBox = await page.getByTestId('sandbox-working-dir').boundingBox();
  expect(sandboxInputBox?.height).toBe(32);
  await expectNoPageOverflow(page);

  // A real field error is owned by FormField, at the field.
  await page.getByTestId('sandbox-tab-resource').click();
  await page.getByTestId('sandbox-resource-add').click();
  const validate = page.getByTestId('sandbox-preflight');
  const enter = page.getByTestId('sandbox-enter');
  await page.getByTestId('sandbox-tab-overview').click();
  await validate.click();
  await page.getByTestId('sandbox-tab-resource').click();
  const fieldError = page.getByTestId('sandbox-resource-key-error-0');
  await expect(fieldError).toHaveAttribute('data-recipe-part', 'form-error');
  await expect(fieldError).toHaveAttribute('role', 'alert');
  const fieldErrorColor = await fieldError.evaluate(
    (element) => getComputedStyle(element).color,
  );
  expect(fieldErrorColor).toBe(projectErrorColor);

  await page.getByTestId('sandbox-tab-overview').click();
  await settledHeight(validate, 32);
  await settledHeight(enter, 32);
  expect((await validate.boundingBox())!.x).toBeLessThan((await enter.boundingBox())!.x);
  const sandboxSecondary = await validate.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  const sandboxPrimary = await enter.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  expect(sandboxSecondary).toBe(projectSecondary);
  expect(sandboxPrimary).toBe(projectPrimary);

  // A long identity/path wraps instead of widening the page.
  await page.getByTestId('sandbox-tab-filesystem').click();
  await page.getByTestId('sandbox-fs-read-add').click();
  await page.getByTestId('sandbox-fs-read-0').fill(
    '/Users/nathan/code/nession/.claude/worktrees/feat-3137-capability-surface-grammar/web/src/product/project/components/very-long-directory',
  );
  await expectNoPageOverflow(page);
});
