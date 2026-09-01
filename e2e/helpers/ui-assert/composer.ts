import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

export interface ComposerFontExpectation {
  experience: 'web' | 'app';
  fontSizePx: number;
  tolerancePx?: number;
}

/**
 * Assert capsule ghost input font-size matches contract token resolution.
 * Requires session-first terminal with capsule visible.
 */
export async function expectComposerFontSize(
  page: Page,
  { fontSizePx, tolerancePx = 1 }: ComposerFontExpectation,
): Promise<void> {
  const input = page.getByTestId('capsule-ghost-input');
  await expect(input).toBeVisible();
  const fontSize = await input.evaluate((el) => getComputedStyle(el).fontSize);
  const parsed = Number.parseFloat(fontSize);
  expect(Math.abs(parsed - fontSizePx)).toBeLessThanOrEqual(tolerancePx);
}

export async function expectAppFieldFullWidth(page: Page): Promise<void> {
  const row = page.getByTestId('capsule-input-row');
  await expect(row).toHaveAttribute('data-field-first', 'app');
  await expect(page.getByTestId('capsule-input-field')).toHaveAttribute('data-input-width', 'full');
}
