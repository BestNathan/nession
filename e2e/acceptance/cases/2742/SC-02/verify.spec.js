'use strict';
// #2742 SC-02: a valid relative Markdown link selects the listed topic;
// #fragment and file.md#fragment reach the target heading after render; the
// index remains one click away.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

test('SC-02: index links, fragments and the return to MEMORY.md stay in the reader', async ({ page }) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-02');

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/fixture/workspace?capability=claude-code&memory=ready');
  await page.getByRole('tab', { name: 'Memory' }).click();
  await expect(page.getByRole('heading', { name: 'Nession project memory' })).toBeVisible();

  await page.getByRole('link', { name: 'Architecture constraints' }).click();
  await expect(page.getByRole('button', { name: 'architecture.md' })).toHaveAttribute(
    'aria-current',
    'true',
  );
  await expect(page.getByRole('heading', { name: 'Session boundary' })).toBeInViewport();

  await page.getByRole('button', { name: 'MEMORY.md' }).click();
  await expect(page.getByRole('heading', { name: 'Nession project memory' })).toBeVisible();

  await page.getByRole('link', { name: 'Interaction principles' }).click();
  await expect(page.locator('table.nession-frontmatter')).toContainText('Interaction principles');
  await expect(page.getByRole('heading', { name: 'Mobile UX' })).toBeInViewport();

  await page.getByRole('link', { name: 'Recovery' }).click();
  await expect(page.getByRole('heading', { name: 'Retry strategy' })).toBeInViewport();

  // A relative backlink from a nested topic resolves against its own directory
  // and lands on the architecture heading.
  await page.getByRole('link', { name: 'Back' }).click();
  await expect(page.getByRole('button', { name: 'architecture.md' })).toHaveAttribute(
    'aria-current',
    'true',
  );
  await expect(page.getByRole('heading', { name: 'Session boundary' })).toBeInViewport();

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ' at 1440x900: clicking Architecture constraints selected and ' +
      'marked architecture.md and reached Session boundary; MEMORY.md returned to the index; ' +
      'Interaction principles reached Mobile UX; topics/recovery.md resolved its nested ' +
      'fragment, and its ../architecture.md#session-boundary backlink returned to the target ' +
      'heading — every step stayed inside the same Memory reader',
  });
});
