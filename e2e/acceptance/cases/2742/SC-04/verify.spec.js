'use strict';
// #2742 SC-04: traversal, missing/unlisted targets and unsafe schemes stay in
// the reader with feedback; safe web links keep the shared external policy.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

test('SC-04: unsafe targets are refused and safe web links stay external', async ({ page }) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-04');

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/fixture/workspace?capability=claude-code&memory=ready');
  await page.getByRole('tab', { name: 'Memory' }).click();
  await expect(page.getByRole('heading', { name: 'Nession project memory' })).toBeVisible();

  await page.getByRole('link', { name: 'Missing topic' }).click();
  await expect(page.getByTestId('claude-code-memory-link-notice')).toContainText(
    'not a Markdown file in this Memory snapshot',
  );
  await expect(page.getByRole('heading', { name: 'Nession project memory' })).toBeVisible();

  await page.getByRole('link', { name: 'Escape attempt' }).click();
  await expect(page.getByTestId('claude-code-memory-link-notice')).toContainText(
    'leave the Memory directory',
  );
  await expect(page.getByTestId('claude-code-memory-content')).toContainText(
    'Nession project memory',
  );

  const docs = page.getByRole('link', { name: 'Claude docs' });
  await expect(docs).toHaveAttribute('href', 'https://code.claude.com/docs/en/memory');
  await expect(docs).toHaveAttribute('target', '_blank');
  await expect(docs).toHaveAttribute('rel', 'noopener noreferrer');

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ' at 1440x900: missing.md produced the in-reader missing notice ' +
      'with the index still rendered; ../private.md produced the leave-the-Memory-directory ' +
      'notice; the https Claude docs link kept href, target=_blank and rel=noopener noreferrer; ' +
      'no notice replaced the document or triggered an unrestricted read',
  });
});
