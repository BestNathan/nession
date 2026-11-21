// #3799 SC-04: the existing Images inline expand/navigation, Build/Distribution
// separation and Session-scoped consumer authorization continue to work, and
// the approved prototype remains independently readable at its pinned source.
import { expect, test, type Page } from '@playwright/test';

const PROTOTYPE_SHA = 'a3bd88ab291dd1861538fd32fec36e3aab8fa5c9';
const PROTOTYPE_ROOT = 'sandbox-capability-3124';
const PAGES = 'https://bestnathan.github.io/nession/';

async function openWebImages(page: Page): Promise<void> {
  await page.goto('/#/fixture/workspace?capability=sandbox&images=lifecycle');
  await expect(page.getByTestId('sandbox-workspace')).toBeVisible();
  await page.getByTestId('sandbox-section-images').click();
  await expect(page.getByTestId('images-panel')).toBeVisible();
}

test('SC-04: Images stays Session-scoped and the prototype source is pinned', async ({
  page,
  request,
}) => {
  test.setTimeout(240_000);
  const sha = String(process.env.NESSION_ACCEPTANCE_TARGET_SHA ?? '');
  expect(sha).toMatch(/^[0-9a-f]{40}$/);
  const observed: string[] = [];

  await page.setViewportSize({ width: 1180, height: 900 });
  await openWebImages(page);
  for (const section of ['library', 'builds', 'distribution']) {
    await expect(page.getByTestId(`images-section-${section}`)).toBeVisible();
  }
  // One Server registry presented inside Sandbox; no independent global tool.
  await expect(page.getByTestId('workspace-tool-images')).toHaveCount(0);
  await expect(page.getByTestId('sidebar-tool-images')).toHaveCount(0);

  // Inline expansion is still a single row-local detail.
  await page.getByTestId('image-row').first().click();
  await expect(page.getByTestId('image-detail-row')).toBeVisible();
  await expect(page.getByTestId('images-detail')).toBeVisible();
  await page.getByTestId('image-row').nth(1).click();
  await expect(page.getByTestId('image-detail-row')).toHaveCount(1);
  observed.push('1180x900: Library/Builds/Distribution remain inside Sandbox with one inline detail');

  // The durable Build surface remains reachable and is not a Library row.
  await page.getByTestId('images-section-builds').click();
  await expect(page.getByTestId('images-builds')).toBeVisible();
  await expect(page.getByTestId('image-build-row').first()).toBeVisible();
  observed.push('Build activity remains the durable Server build surface');

  // No Session means no Sandbox capability entry, so Images is not global.
  await page.goto('/#/fixture/workspace?session=none');
  await page.reload();
  await expect(page.getByTestId('workspace-tool-bar')).toBeVisible();
  await expect(page.getByTestId('workspace-tool-sandbox')).toHaveCount(0);
  await expect(page.getByTestId('images-panel')).toHaveCount(0);
  observed.push('session=none: no Sandbox/Images entry');

  // App keeps its one host header and Back while showing the same panel.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/fixture/app?images=lifecycle');
  await page.getByTestId('app-layer-root').waitFor();
  await page.getByTestId('app-header-workspace').click();
  await page.getByTestId('workspace-tool-sandbox').click();
  await page.getByTestId('sandbox-section-images').click();
  await expect(page.getByTestId('images-panel')).toBeVisible();
  await expect(page.getByTestId('app-page-header')).toHaveCount(1);
  await expect(page.getByTestId('app-page-back')).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
  observed.push('390x844: App retains one header/Back without overflow');

  // ── The approved prototype is published and pinned ──
  const manifestResponse = await request.get(PAGES + 'prototypes/manifest.json');
  expect(manifestResponse.ok(), 'published prototype manifest responds').toBe(true);
  const manifest = (await manifestResponse.json()) as {
    source?: { sha?: string };
    entries?: Array<{ slug?: string; preview?: string; source?: string }>;
  };
  const sourceSha = manifest.source?.sha ?? '';
  expect(sourceSha).toMatch(/^[0-9a-f]{40}$/);
  const entry = (manifest.entries ?? []).find((item) => item.slug === PROTOTYPE_ROOT);
  expect(entry, 'the Images prototype is in the published gallery').toBeTruthy();
  expect(entry?.source).toContain(sourceSha);
  expect(entry?.source).toContain(PROTOTYPE_ROOT);

  const previewResponse = await request.get(PAGES + String(entry?.preview));
  expect(previewResponse.ok(), 'the direct prototype preview responds').toBe(true);
  const preview = await previewResponse.text();
  expect(preview).toContain('3799');
  expect(preview).toContain('Tag');

  const pinned = await request.get(
    `https://raw.githubusercontent.com/BestNathan/nession/${PROTOTYPE_SHA}/${PROTOTYPE_ROOT}/index.html`,
  );
  expect(pinned.ok(), 'the pinned immutable prototype source responds').toBe(true);
  expect(await pinned.text()).toContain('3799');
  const design = await request.get(
    `https://raw.githubusercontent.com/BestNathan/nession/${PROTOTYPE_SHA}/${PROTOTYPE_ROOT}/IMAGES_DESIGN.md`,
  );
  expect(design.ok(), 'the pinned Images design note responds').toBe(true);
  const designText = await design.text();
  expect(designText).toContain('#3799');
  expect(designText).toContain('Tag');

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': ' + observed.join('; ') +
      '; the public prototype manifest pins source ' + sourceSha +
      ' with the ' + PROTOTYPE_ROOT + ' entry, the preview carries #3799 Tag content, and the pinned source at ' +
      PROTOTYPE_SHA + ' plus its IMAGES_DESIGN.md were fetchable',
  });
});
