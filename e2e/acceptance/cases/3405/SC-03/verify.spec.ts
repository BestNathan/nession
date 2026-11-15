// #3405 SC-03: real Chromium proof of the published, source-pinned Filesystem
// prototype. The product view must present RootFS → Mounts → Workspace →
// Access → Preview as five simultaneously rendered policy sections, with the
// Workspace choice and live Preview reflecting the mapping. App 390 keeps the
// same five sections under touch. This is prototype evidence, not production
// runtime acceptance.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { verifiedRuntime } from '../../../shared/foreground-resume-browser.cjs';

const PROTOTYPE_URL =
  'https://bestnathan.github.io/nession/prototypes/sandbox-capability-3124/index.html';

function product(page: Page): Locator {
  return page.locator('#sandbox-product');
}

async function openFilesystem(page: Page): Promise<Locator> {
  const view = product(page);
  await expect(view).toBeVisible();
  await view.locator('[data-action="area:policies"]').first().click();
  await view.locator('[data-action="sub:policies:filesystem"]').click();
  const editor = view.locator('.fs-editor');
  await expect(editor).toBeVisible();
  return editor;
}

async function expectFiveSections(editor: Locator): Promise<void> {
  const sections = editor.locator('[data-fs-section]');
  await expect(sections).toHaveCount(5);
  for (const [key, title] of [
    ['rootfs', '1 · RootFS'],
    ['mounts', '2 · Mounts'],
    ['workspace', '3 · Workspace'],
    ['access', '4 · Access'],
    ['preview', '5 · Preview'],
  ]) {
    const section = editor.locator(`[data-fs-section="${key}"]`);
    await expect(section).toBeVisible();
    await expect(section.locator('h3')).toHaveText(title);
    const box = await section.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThan(0);
  }
}

async function noHorizontalOverflow(container: Locator): Promise<boolean> {
  return container.evaluate(
    (element) => element.scrollWidth <= element.clientWidth + 1,
  );
}

test('SC-03: the published prototype renders five Filesystem sections and a live mapping', async ({
  page,
}) => {
  test.setTimeout(110_000);
  const { sha } = verifiedRuntime('SC-03');
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  await page.goto(PROTOTYPE_URL);
  await expect(product(page)).toHaveAttribute('data-mode', 'web');
  const editor = await openFilesystem(page);
  await expectFiveSections(editor);

  // Mounts is an empty-by-default list of non-Base images, not a mandatory
  // pre-populated control.
  await expect(editor.locator('[data-fs-mount]')).toHaveCount(0);
  await editor.locator('[data-action="mount-add"]').click();
  await expect(editor.locator('[data-fs-mount]')).toHaveCount(1);

  // Workspace: Project Location is an immutable reference at the implicit
  // /workspace target; the Preview renders that mapping.
  await editor.locator('[data-action="fs-ws:project"]').click();
  await expect(
    editor.locator('[data-fs-section="workspace"] [data-action="fs-ws:project"]'),
  ).toHaveAttribute('aria-pressed', 'true');
  const preview = editor.locator('[data-fs-section="preview"]');
  await expect(preview).toContainText('/workspace');
  await expect(preview).toContainText('/home/dev/projects/nession');

  // Access is an identity path list; editing it updates the Preview live.
  // The prototype re-renders on `change`, so blur each field before moving to
  // the next control (a focused input left mounted would be replaced).
  const readPath = editor.locator('[data-fs-path="read"]').first();
  await readPath.fill('/srv/readonly-data');
  await expect(preview).toContainText('/srv/readonly-data');
  await readPath.evaluate((element) => (element as HTMLInputElement).blur());
  const writePath = editor.locator('[data-fs-path="write"]').first();
  await writePath.fill('/srv/writable-data');
  await expect(preview).toContainText('/srv/writable-data');
  await writePath.evaluate((element) => (element as HTMLInputElement).blur());

  // RootFS at `/` switches between Local and a cached Base Runtime EROFS.
  await editor.locator('[data-action="fs-mode:image"]').click();
  await expect(preview).toContainText('minimal-glibc-runtime');
  await editor.locator('[data-action="fs-mode:host"]').click();
  await expect(preview).toContainText('Local filesystem');

  expect(await noHorizontalOverflow(product(page))).toBe(true);
  expect(pageErrors, 'the public prototype must not throw').toEqual([]);
  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': Chromium rendered the published sandbox-capability-3124 ' +
      'prototype with five simultaneous sections (RootFS/Mounts/Workspace/Access/Preview), ' +
      'empty-by-default Mounts, Project Location at /workspace, live Access→Preview mapping, ' +
      'Local↔EROFS RootFS, and no horizontal overflow at Web 1180',
  });
});

test.describe('App touch', () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

  test('SC-03: the App prototype keeps all five Filesystem sections under touch', async ({
    page,
  }) => {
    test.setTimeout(110_000);
    const { sha } = verifiedRuntime('SC-03');
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));

    await page.goto(PROTOTYPE_URL);
    await page.locator('[data-np-size="390"]').tap();
    await expect(product(page)).toHaveAttribute('data-mode', 'app');

    const view = product(page);
    await view.locator('[data-action="area:policies"]').first().tap();
    await view.locator('[data-action="sub:policies:filesystem"]').tap();
    const editor = view.locator('.fs-editor');
    await expectFiveSections(editor);

    // Selecting the external Project Location at App width keeps the same
    // five-section editor and the implicit /workspace mapping under touch.
    await editor.locator('[data-action="fs-ws:project"]').tap();
    await expect(
      editor.locator('[data-fs-section="workspace"] [data-action="fs-ws:project"]'),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(editor.locator('[data-fs-section="preview"]')).toContainText('/workspace');
    expect(await noHorizontalOverflow(view)).toBe(true);
    expect(pageErrors, 'the public prototype must not throw').toEqual([]);
    test.info().annotations.push({
      type: 'evidence',
      description:
        'exact SHA ' + sha + ': Chromium touch at App 390 tapped Policies → Filesystem and ' +
        'observed all five sections, the Project Location /workspace mapping in Preview, and no ' +
        'horizontal overflow',
    });
  });
});
