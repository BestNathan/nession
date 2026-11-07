// #2875 SC-04: the App keeps its spatial Sessions/Terminal/Workspace model,
// search/grouping/new-session affordances and touch floor with no Web
// sidebar/rail/collapse, and the App-specific interactive prototype is
// published/reviewable (Pages manifest + pinned immutable source + preview).
import { expect, test } from '@playwright/test';
import { freezeFixtureClock, gotoFixtureApp } from '../../../../helpers/fixtureVisual';

test('SC-04: App spatial navigation and the published prototype artifact', async ({ page, request }) => {
  test.setTimeout(240_000);
  const sha = String(process.env.NESSION_ACCEPTANCE_TARGET_SHA ?? '');
  expect(sha).toMatch(/^[0-9a-f]{40}$/);
  const observed: string[] = [];

  for (const viewport of [
    { width: 390, height: 844 },
    { width: 375, height: 812 },
  ]) {
    await freezeFixtureClock(page);
    await page.setViewportSize(viewport);
    await gotoFixtureApp(page, '');
    // The first iteration ends on the Sessions layer; the same-hash goto does
    // not reload, so reset the fixture to its Terminal root for the next
    // viewport (and re-establish the route, not the previous layer state).
    await page.reload();
    await expect(page.getByTestId('app-layer-root')).toHaveAttribute('data-layer', 'terminal');
    await expect(page.getByTestId('app-layer-terminal')).toBeInViewport();
    await expect(page.getByTestId('session-header-line')).toHaveCount(1);

    // No Web composition leaked in: no column, rail, drawer or collapse control.
    await expect(page.getByTestId('sidebar-column')).toHaveCount(0);
    await expect(page.getByTestId('sidebar-rail')).toHaveCount(0);
    await expect(page.getByTestId('sidebar-collapse')).toHaveCount(0);
    await expect(page.getByTestId('session-drawer')).toHaveCount(0);

    // Sessions is the App's own spatial layer, not a drawer over the Web shell.
    if ((await page.getByTestId('app-layer-root').getAttribute('data-layer')) !== 'sessions') {
      await page.getByTestId('app-header-sessions').first().click();
    }
    await expect(page.getByTestId('app-layer-sessions')).toBeInViewport();
    await expect(page.getByTestId('app-sessions-surface')).toBeVisible();
    await expect(page.getByPlaceholder('Search sessions...')).toBeVisible();
    await expect(page.getByTestId('session-group-label')).toHaveCount(3);
    await expect(page.getByTestId('create-session')).toBeVisible();

    // Touch floor on the App row's primary control and its 44px action trigger.
    const rowControl = await page.getByTestId('session-item-devbox-01:design-system').boundingBox();
    expect(rowControl?.height).toBeGreaterThanOrEqual(44);
    const trigger = await page.getByTestId('session-actions-devbox-01:design-system').boundingBox();
    expect(trigger?.width).toBe(44);
    expect(trigger?.height).toBe(44);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
    observed.push(`${viewport.width}x${viewport.height}: spatial layer, no Web chrome, touch floor 44, no overflow`);
  }

  // ── Published, reviewable prototype artifact (SCN-08 design support) ──
  const base = 'https://bestnathan.github.io/nession/';
  const manifestResponse = await request.get(base + 'prototypes/manifest.json');
  expect(manifestResponse.ok(), 'published prototype manifest responds').toBe(true);
  const manifest = (await manifestResponse.json()) as {
    source?: { sha?: string };
    entries?: Array<{ slug?: string; preview?: string; source?: string }>;
  };
  const sourceSha = manifest.source?.sha ?? '';
  expect(sourceSha).toMatch(/^[0-9a-f]{40}$/);
  const entry = (manifest.entries ?? []).find((item) => item.slug === 'app-session-actions-2875');
  expect(entry, 'the App Sessions prototype is in the published gallery').toBeTruthy();
  expect(entry?.source).toContain(sourceSha);
  expect(entry?.source).toContain('app-session-actions-2875');

  const previewResponse = await request.get(base + String(entry?.preview));
  expect(previewResponse.ok(), 'the direct prototype preview responds').toBe(true);
  const preview = await previewResponse.text();
  expect(preview).toContain('ui-spec');
  expect(preview).toContain('2875');

  const pinnedResponse = await request.get(
    `https://raw.githubusercontent.com/BestNathan/nession/${sourceSha}/app-session-actions-2875/index.html`,
  );
  expect(pinnedResponse.ok(), 'the pinned immutable prototype source responds').toBe(true);
  expect(await pinnedResponse.text()).toContain('2875');

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': ' + observed.join('; ') +
      '; the public prototype manifest pins source ' + sourceSha + ' with the app-session-actions-2875 entry, and ' +
      'both the direct preview and the pinned immutable source were fetchable and carried the App Sessions prototype',
  });
});
