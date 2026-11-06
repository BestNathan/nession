'use strict';
// #2742 SC-01: MEMORY.md and topic files render as safe rich Markdown
// (GFM, code, links, lists, tables), not raw <pre>, at Web and narrow widths.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

test('SC-01: Memory renders as a rich document on Web and at phone width', async ({ page }) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-01');

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/fixture/workspace?capability=claude-code&memory=ready');
  await page.getByRole('tab', { name: 'Memory' }).click();
  await expect(page.getByTestId('claude-code-memory')).toHaveAttribute('data-state', 'ready');

  // The index is a document: heading, list item, link; never the raw <pre>.
  await expect(page.getByRole('heading', { name: 'Nession project memory' })).toBeVisible();
  await expect(
    page.locator('li').filter({ hasText: 'Architecture constraints' }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Architecture constraints' })).toBeVisible();
  await expect(page.getByTestId('claude-code-memory-raw')).toHaveCount(0);

  // A topic renders headings, a table and a highlighted code fence.
  await page.getByRole('link', { name: 'Architecture constraints' }).click();
  await expect(page.getByRole('heading', { name: 'Session boundary' })).toBeVisible();
  await expect(page.locator('table.nession-frontmatter')).toContainText('Architecture constraints');
  await expect(page.getByRole('cell', { name: 'Repository' })).toBeVisible();
  await expect(page.getByTestId('claude-code-memory-content')).toContainText('fn main');

  // Narrow: readable wrapping and a bounded document scroller.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('heading', { name: 'Session boundary' })).toBeVisible();
  const overflow = await page
    .getByTestId('claude-code-memory-content')
    .evaluate((element) => getComputedStyle(element).overflowY);
  expect(['auto', 'scroll']).toContain(overflow);
  const horizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(horizontalOverflow).toBeLessThanOrEqual(1);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ' at 1440x900 and 390x844: MEMORY.md rendered as a document ' +
      '(heading, list item, link) with no raw pre; architecture.md rendered its YAML ' +
      'metadata, a body table and a highlighted Rust fence; the document scrolled inside ' +
      'its own overflow-y surface with no page-level horizontal overflow',
  });
});
