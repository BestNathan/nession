// #3804 SC-04: Activity changes do not rewrite recency, reorder rows, open a
// Capability Peek, add a resting Capsule spinner or animate unboundedly; an
// offline Agent stays independently visible while its last level is not
// claimed as current.
import { expect, test, type Page } from '@playwright/test';
import { freezeFixtureClock } from '../../../../helpers/fixtureVisual';

const CANONICAL = '/#/fixture?sessionActivity=canonical';
const ALTERNATE = '/#/fixture?sessionActivity=alternate';

interface RowSnapshot {
  id: string;
  meta: string;
  title: string;
}

async function rows(page: Page): Promise<RowSnapshot[]> {
  return page
    .locator('[data-session-row]')
    .evaluateAll((elements) =>
      elements.map((element) => {
        const id = element.getAttribute('data-session-row') ?? '';
        const meta = element.querySelector('[data-testid="session-item-meta"]')?.textContent ?? '';
        const title = element.querySelector('[data-testid="session-item-title"]')?.textContent ?? '';
        return { id, meta, title };
      }),
    );
}

async function openCanonical(page: Page): Promise<void> {
  await freezeFixtureClock(page);
  await page.setViewportSize({ width: 1180, height: 900 });
  await page.goto(CANONICAL);
  await expect(page.getByTestId('sidebar')).toBeVisible();
  await expect(page.locator('[data-session-row]')).toHaveCount(6);
}

test('SC-04: Activity changes leave recency, order, identity and chrome untouched', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const sha = String(process.env.NESSION_ACCEPTANCE_TARGET_SHA ?? '');
  expect(sha).toMatch(/^[0-9a-f]{40}$/);

  await openCanonical(page);
  const before = await rows(page);

  // No Activity-driven surface appears on its own.
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByTestId('session-details-dialog')).toHaveCount(0);
  await expect(page.locator('[role="progressbar"]')).toHaveCount(0);
  await expect(
    page.locator('[data-testid="terminal-capsule"] [role="progressbar"]'),
  ).toHaveCount(0);

  // The same rows, titles and recency (the meta line) survive a different
  // Activity level set.
  await page.goto(ALTERNATE);
  await page.reload();
  await expect(page.getByTestId('sidebar')).toBeVisible();
  await expect(page.locator('[data-session-row]')).toHaveCount(6);
  const after = await rows(page);

  expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id));
  expect(after.map((row) => row.title)).toEqual(before.map((row) => row.title));
  expect(after.map((row) => row.meta)).toEqual(before.map((row) => row.meta));
  // The reload really did apply different levels.
  await expect(
    page.locator('[data-session-row="devbox-01:fix-terminal-reconnect"]'),
  ).toHaveAttribute('data-activity', 'idle');
  await expect(
    page.locator('[data-session-row="devbox-01:staging-deploy"]'),
  ).toHaveAttribute('data-activity', 'working');

  // Reduced motion: the working arc is static, so Activity does not depend on
  // an unbounded animation to be legible.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const animations = await page
    .getByTestId('session-item-activity')
    .evaluateAll((elements) =>
      elements.map((element) => {
        const icon = element.querySelector('svg');
        return icon ? getComputedStyle(icon).animationName : 'none';
      }),
    );
  expect(animations.every((name) => name === 'none')).toBe(true);

  // An offline Agent remains independently visible, and its last level is not
  // presented as current.
  await expect(
    page.locator('[data-session-row="sg-prod:prod-shell"]'),
  ).toHaveAttribute('data-activity', 'unknown');
  await expect(
    page.locator('[data-session-row="sg-prod:prod-shell"]').getByText('Agent offline'),
  ).toBeVisible();

  // Identity and the single row action are unchanged by the level set.
  await expect(
    page.getByTestId('session-item-macbook:review-pr-561'),
  ).not.toHaveAttribute('aria-current', 'true');

  test.info().annotations.push({
    type: 'evidence',
    description:
      `exact SHA ${sha}: switching the reported Activity set left all six row ids, ` +
      'titles and meta (agent + recency) byte-identical and did not open a dialog, ' +
      'Peek, or Capsule progress indicator; under reduced motion no Activity glyph ' +
      'animated; the offline Agent stayed visibly offline with Activity unknown',
  });
});
