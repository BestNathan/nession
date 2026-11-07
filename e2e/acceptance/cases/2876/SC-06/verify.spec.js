'use strict';
// #2876 SC-06: desktop and narrow App-like Chromium viewports preserve the
// selected row/status, keep Preview/Raw and media controls usable, contain
// scrolling inside the pane, and introduce no global navigation.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

async function expectContained(page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
}

test('SC-06: text, structured and media stay usable at desktop and phone widths', async ({ page }) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-06');

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto('/#/fixture/workspace?capability=git&git=preview-states');
    await page.getByTestId('git-change-list').waitFor();

    const row = page.getByTestId('git-row-untracked').filter({ hasText: 'src/long-preview.txt' });
    await row.click();
    await expect(row).toHaveAttribute('aria-current', 'true');
    await expect(row).toBeFocused();
    await expect(page.getByTestId('git-file-preview-path')).toHaveText('src/long-preview.txt');
    await expect(page.getByTestId('git-file-preview-status')).toBeVisible();
    const body = page.getByTestId('git-file-preview-body');
    await expect(body).toHaveCSS('overflow-y', 'auto');
    // The pane is the scroller: CodeMirror grows to its content inside it.
    const scroll = await body.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      return {
        scrollTop: element.scrollTop,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
      };
    });
    expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight);
    expect(scroll.scrollTop).toBeGreaterThan(0);
    expect(
      await body.evaluate(
        (element) => Number.parseFloat(getComputedStyle(element).paddingBottom),
      ),
    ).toBeGreaterThan(0);
    await expectContained(page);

    await page.getByTestId('git-row-untracked').filter({ hasText: 'notes/data.json' }).click();
    const mode = page.getByRole('group', { name: 'View mode' });
    await expect(mode.getByRole('button', { name: 'Preview', exact: true })).toBeVisible();
    await expect(mode.getByRole('button', { name: 'Preview', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(mode.getByRole('button', { name: 'Raw', exact: true, pressed: false })).toBeVisible();
    await expect(page.getByRole('tree')).toBeVisible();
    await expectContained(page);

    await page.getByTestId('git-row-untracked').filter({ hasText: 'assets/photo.png' }).click();
    const image = page.getByTestId('image-viewer');
    await expect(image).toBeVisible();
    await expect(page.getByRole('button', { name: 'Zoom in' })).toBeVisible();
    const fits = await body.evaluate((element) => {
      const media = element.querySelector('[data-testid="image-viewer"]');
      return media ? media.getBoundingClientRect().width <= element.getBoundingClientRect().width : false;
    });
    expect(fits).toBe(true);
    await expectContained(page);
  }

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': at 1440x900 and 390x844 the selected row stayed current/focused with ' +
      'its path and status, the pane scrolled internally with Capsule clearance, Preview/Raw and ' +
      'image controls stayed visible, the image fit the pane, and neither viewport overflowed',
  });
});
