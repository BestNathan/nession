'use strict';
// #2742 SC-05 browser half: a partial document reports its state, the deferred
// fragment waits for the continuation, and a narrow viewport keeps the reader
// bounded. Context-switch staleness is proven by the runtime half.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

test('SC-05: partial content and the deferred fragment stay truthful at phone width', async ({ page }) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-05');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/fixture/workspace?capability=claude-code&memory=partial');
  await page.getByRole('tab', { name: 'Memory' }).click();
  await expect(page.getByTestId('claude-code-memory')).toHaveAttribute('data-state', 'ready');

  await page.getByRole('link', { name: 'Recovery record' }).click();
  await expect(page.getByTestId('claude-code-memory-partial')).toContainText('not fully loaded');
  await expect(page.getByTestId('claude-code-memory-link-notice')).toContainText(
    'not in the loaded part',
  );
  await expect(page.getByRole('heading', { name: 'Retry strategy' })).toHaveCount(0);

  await page.getByTestId('claude-code-memory-load-more').click();
  await expect(page.getByTestId('claude-code-memory-partial')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Retry strategy' })).toBeInViewport();
  await expect(page.getByTestId('claude-code-memory-link-notice')).toHaveCount(0);

  // A different file replaces the document without the old fragment or notice.
  await page.getByRole('button', { name: 'architecture.md' }).click();
  await expect(page.getByRole('heading', { name: 'Session boundary' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Retry strategy' })).toHaveCount(0);
  await expect(page.getByTestId('claude-code-memory-link-notice')).toHaveCount(0);

  const horizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(horizontalOverflow).toBeLessThanOrEqual(1);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ' at 390x844: topics/recovery.md showed the partial banner and ' +
      'the heading-not-loaded notice without scrolling; Load more removed the banner, ' +
      'rendered Retry strategy in view and cleared the notice; selecting architecture.md ' +
      'replaced the document with no Retry heading or notice left behind; no page-level ' +
      'horizontal overflow',
  });
});
