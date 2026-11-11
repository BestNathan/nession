// #3137 SC-03: App 390×844, 375×812 and 844×390 portrait/landscape keep one
// App-owned Back/header, a stacked touch-safe hierarchy, and the same
// detail/form/operation roles as Web without horizontal overflow or a second
// header. Sandbox Enter preflight and Project create/settings behavior remain
// the shipped behavior.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { freezeFixtureClock } from '../../../../helpers/fixtureVisual';
import { verifiedRuntime } from '../../../shared/foreground-resume-browser.cjs';

const STYLE_KEYS = ['fontSize', 'fontWeight', 'lineHeight'] as const;

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

async function expectNoOverflow(page: Page): Promise<void> {
  const difference = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(difference, 'App horizontal overflow').toBeLessThanOrEqual(1);
}

async function openAppSessions(page: Page): Promise<void> {
  await page.getByTestId('app-layer-root').waitFor();
  await page.getByTestId('app-header-sessions').first().click();
  await expect(page.getByTestId('app-sessions-surface')).toBeVisible();
}

async function openAppProject(page: Page): Promise<Locator> {
  await page.goto('/#/fixture/app?projects=canonical');
  // The fixture reads its scenario from the first load; a hash-only change
  // keeps the mounted layers and their current depth.
  await page.reload();
  await openAppSessions(page);
  await page.getByTestId('project-item-row').first().click();
  const detail = page.getByTestId('app-project-detail');
  await expect(detail).toBeVisible();
  return detail;
}

async function openAppSandbox(page: Page, query = ''): Promise<Locator> {
  await page.goto(`/#/fixture/app${query}`);
  await page.reload();
  await page.getByTestId('app-header-workspace').click();
  await page.getByTestId('workspace-tool-sandbox').click();
  const workspace = page.getByTestId('sandbox-workspace');
  await expect(workspace).toBeVisible();
  return workspace;
}

test('SC-03: App keeps one header, stacked touch hierarchy and unchanged behavior', async ({
  page,
}) => {
  test.setTimeout(110_000);
  verifiedRuntime('SC-03');
  await freezeFixtureClock(page);

  const titleByViewport: Record<string, Record<string, string>> = {};
  const sectionByViewport: Record<string, Record<string, string>> = {};
  const factLabelByViewport: Record<string, Record<string, string>> = {};

  for (const viewport of [
    { width: 390, height: 844 },
    { width: 375, height: 812 },
    { width: 844, height: 390 },
  ]) {
    await page.setViewportSize(viewport);
    const detail = await openAppProject(page);
    await expect(detail.getByTestId('app-page-header')).toHaveCount(1);
    await expect(page.getByTestId('project-detail-title')).toBeVisible();
    // The host header owns the name; the content must not repeat it.
    await expect(detail.locator('[data-recipe-part="detail-title"]')).toHaveCount(0);
    await expectNoOverflow(page);

    const title = await computed(page.getByTestId('project-detail-title'));
    const section = await computed(
      page.getByTestId('project-detail').locator('[data-recipe-part="detail-section-title"]').first(),
    );
    const factLabel = await computed(
      page.getByTestId('project-detail').locator('[data-recipe-part="detail-fact-label"]').first(),
    );
    expect(title.fontSize, 'App surface title').toBe('17px');
    expect(title.fontWeight).toBe('600');
    expect(section.fontSize, 'App section heading').toBe('13px');
    expect(section.fontWeight).toBe('500');
    expect(factLabel.fontSize, 'App fact label').toBe('11.5px');
    titleByViewport[viewport.width] = title;
    sectionByViewport[viewport.width] = section;
    factLabelByViewport[viewport.width] = factLabel;

    // Project Create: one header, named sections, stacked 44px fields.
    await page.getByTestId('app-page-back').click();
    await expect(page.getByTestId('app-sessions-surface')).toBeVisible();
    await page.getByTestId('project-create').click();
    const create = page.getByTestId('app-project-create-page');
    await expect(create).toBeVisible();
    await expect(create.getByTestId('app-page-header')).toHaveCount(1);
    const formSection = await computed(
      create.locator('[data-recipe-part="form-section-title"]').first(),
    );
    expectSameRole(formSection, section);
    const formLabel = await computed(
      create.locator('[data-recipe-part="form-label"]').first(),
    );
    expect(formLabel.fontSize).toBe('14px');
    const nameField = create.locator('#project-create-name');
    expect((await nameField.boundingBox())?.height).toBe(44);
    expect((await create.getByTestId('project-create-submit').boundingBox())?.height).toBe(44);
    const grid = create.locator('[data-recipe-part="form-grid"]').first();
    const columns = await grid.evaluate(
      (element) => getComputedStyle(element).gridTemplateColumns.split(' ').filter(Boolean).length,
    );
    expect(columns, 'App field pairs stack').toBe(1);
    await expectNoOverflow(page);

    // Create still creates and lands on the new Project detail.
    await nameField.fill(`App 3137 ${viewport.width}`);
    await create.getByTestId('project-create-submit').click();
    await expect(page.getByTestId('app-project-detail')).toBeVisible();
    await expect(page.getByTestId('project-detail-title')).toHaveText(
      `App 3137 ${viewport.width}`,
    );
    await expect(
      page.getByTestId('app-project-detail').getByTestId('app-page-header'),
    ).toHaveCount(1);

    // Settings is the same operation surface and Back returns to the detail.
    await page.getByTestId('project-detail-settings').click();
    const settings = page.getByTestId('app-project-settings-page');
    await expect(settings).toBeVisible();
    await expect(settings.getByTestId('app-page-header')).toHaveCount(1);
    expect((await settings.locator('#project-settings-name').boundingBox())?.height).toBe(44);
    expect((await settings.getByTestId('project-settings-submit').boundingBox())?.height).toBe(44);
    await settings.getByTestId('app-page-back').click();
    await expect(page.getByTestId('app-project-detail')).toBeVisible();

    // Leave the Project depth before opening Sandbox.
    await page.getByTestId('app-project-detail').getByTestId('app-page-back').click();
    await expect(page.getByTestId('app-sessions-surface')).toBeVisible();

    // Sandbox Outside: one host header, stacked form, 44px controls/actions.
    await openAppSandbox(page);
    await expect(
      page.getByTestId('app-layer-workspace').getByTestId('app-page-header'),
    ).toHaveCount(1);
    const outsideTitle = await computed(
      page.getByTestId('sandbox-composer').locator('[data-recipe-part="detail-title"]').first(),
    );
    expectSameRole(outsideTitle, title);
    await page.getByTestId('sandbox-tab-filesystem').click();
    const filesystem = page
      .getByTestId('sandbox-composer')
      .locator('[data-recipe="configuration-form"]')
      .first();
    const sandboxSection = await computed(
      filesystem.locator('[data-recipe-part="form-section-title"]').first(),
    );
    expectSameRole(sandboxSection, section);
    const sandboxLabel = await computed(
      filesystem.locator('[data-recipe-part="form-label"]').first(),
    );
    expectSameRole(sandboxLabel, formLabel);
    expect((await page.getByTestId('sandbox-working-dir').boundingBox())?.height).toBe(44);
    const sandboxGrid = filesystem.locator('[data-recipe-part="form-grid"]').first();
    const sandboxColumns = await sandboxGrid.evaluate(
      (element) => getComputedStyle(element).gridTemplateColumns.split(' ').filter(Boolean).length,
    );
    expect(sandboxColumns, 'App Sandbox field pairs stack').toBe(1);
    await expectNoOverflow(page);

    // Enter preflight still validates the exact draft and enables Enter.
    await page.getByTestId('sandbox-tab-overview').click();
    const validate = page.getByTestId('sandbox-preflight');
    const enter = page.getByTestId('sandbox-enter');
    expect((await validate.boundingBox())?.height).toBe(44);
    expect((await enter.boundingBox())?.height).toBe(44);
    await validate.click();
    await expect(page.getByTestId('sandbox-preflight-ok')).toBeVisible();
    await expect(enter).toBeEnabled();
    await expectNoOverflow(page);

    // Sandbox Inside: one header, observed facts with no input chrome.
    await openAppSandbox(page, '?sandbox=inside');
    await expect(
      page.getByTestId('app-layer-workspace').getByTestId('app-page-header'),
    ).toHaveCount(1);
    const inside = page.getByTestId('sandbox-inside');
    const insideTitle = await computed(
      inside.locator('[data-recipe-part="detail-title"]').first(),
    );
    expectSameRole(insideTitle, title);
    const insideFact = await computed(
      inside.locator('[data-recipe-part="detail-fact-label"]').first(),
    );
    expectSameRole(insideFact, factLabel);
    await expect(
      inside.locator('[data-recipe="resource-detail"]').first().locator('input, textarea, select, fieldset'),
    ).toHaveCount(0);
    await expectNoOverflow(page);
  }

  for (const width of [375, 844] as const) {
    expectSameRole(titleByViewport[width], titleByViewport[390]);
    expectSameRole(sectionByViewport[width], sectionByViewport[390]);
    expectSameRole(factLabelByViewport[width], factLabelByViewport[390]);
  }
});
