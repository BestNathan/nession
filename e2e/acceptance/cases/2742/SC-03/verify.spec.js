'use strict';
// #2742 SC-03: valid YAML/TOML frontmatter is legible metadata beside the body;
// malformed frontmatter does not crash or hide the remaining content.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

test('SC-03: YAML, TOML and malformed frontmatter keep a readable body', async ({ page }) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-03');

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/fixture/workspace?capability=claude-code&memory=ready');
  await page.getByRole('tab', { name: 'Memory' }).click();
  await expect(page.getByRole('heading', { name: 'Nession project memory' })).toBeVisible();

  // YAML frontmatter: a table, separated from the body heading.
  await page.getByRole('link', { name: 'Architecture constraints' }).click();
  const yaml = page.locator('table.nession-frontmatter');
  await expect(yaml).toContainText('title');
  await expect(yaml).toContainText('owner');
  await expect(page.getByRole('heading', { name: 'Session boundary' })).toBeVisible();

  // TOML frontmatter: the same metadata treatment, never a crash.
  await page.getByRole('button', { name: 'MEMORY.md' }).click();
  await page.getByRole('link', { name: 'Interaction principles' }).click();
  await expect(page.locator('table.nession-frontmatter')).toContainText('status');

  // Malformed/unclosed YAML: the body remains readable and the reader is alive.
  await page.getByRole('button', { name: 'MEMORY.md' }).click();
  await page.getByRole('link', { name: 'Malformed metadata' }).click();
  await expect(page.getByRole('heading', { name: 'Body still readable' })).toBeVisible();
  await expect(page.getByTestId('claude-code-memory')).toHaveAttribute('data-state', 'ready');

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ' at 1440x900: architecture.md showed a YAML frontmatter table ' +
      'with its keys beside the body; interaction.md showed a TOML frontmatter table; ' +
      'malformed.md (unclosed YAML) still rendered its Body still readable heading and the ' +
      'Memory view stayed in the ready state instead of crashing or hiding content',
  });
});
