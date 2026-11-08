'use strict';
// #845 SC-16: the browser surface exercises the write flow the source-aligned
// Cases prove at the protocol boundary: review, stage, confirm, commit.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

test('SC-16: the Workspace stages a reviewed file and commits it after confirmation', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-16');

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/fixture/workspace?capability=git');
  await page.getByTestId('git-change-list').waitFor();

  const target = page
    .getByTestId('git-row-unstaged')
    .filter({ hasText: 'web/src/capabilities/git/GitPlugin.ts' });
  await target.click();
  await page
    .getByRole('button', { name: 'Stage web/src/capabilities/git/GitPlugin.ts' })
    .click();
  await expect(page.getByTestId('git-group-staged')).toContainText(
    'web/src/capabilities/git/GitPlugin.ts',
  );

  await page.getByTestId('git-commit-message').fill('feat(git): acceptance write flow');
  await expect(page.getByTestId('git-commit')).toBeEnabled();
  await page.getByTestId('git-commit').click();
  await expect(page.getByTestId('git-commit-dialog')).toBeVisible();
  await expect(page.getByTestId('git-commit-dialog')).toContainText('hooks');
  await page.getByTestId('git-commit-confirm').click();

  await expect(page.getByTestId('git-group-staged')).toHaveCount(0);
  await expect(page.getByTestId('git-commit-form')).toHaveCount(0);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': GitPlugin.ts moved from Changes to Staged through a ' +
      'snapshot-checked stage; the commit form required a message and a confirmation ' +
      'naming hooks; the post-commit answer cleared the staged group and the form',
  });
});
