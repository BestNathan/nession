import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Trigger→popup geometry for a standard anchored Select (issue 3246).
 *
 * The invariant is intentionally about *relative* coordinates, not about a
 * screenshot of one form: a Select opens below its trigger with its start edge
 * on the trigger's start edge, `sideOffset` away, after the opening animation
 * has settled. `width="content"` may grow the list but must not move that
 * start edge.
 *
 * Base UI owns collision avoidance. Near a viewport edge the popup may shift
 * horizontally or flip above the trigger; those cases assert that the list
 * stayed visible/operable rather than forcing the no-collision coordinates.
 */
export interface SelectAnchorMeasurement {
  trigger: { x: number; y: number; width: number; height: number };
  popup: { x: number; y: number; width: number; height: number };
  dx: number;
  gap: number;
  side: string;
  horizontalCollision: boolean;
}

/**
 * Read or throw; `boundingBox()` is nullable because a locator may resolve to
 * zero elements, which is a failure here, not a measurement of zero.
 */
async function box(locator: Locator): Promise<SelectAnchorMeasurement['popup']> {
  const measured = await locator.boundingBox();
  if (!measured) throw new Error('expected a measurable element');
  return measured;
}

/** Wait for the opening animation to stop moving/resizing the popup. */
export async function settledBox(
  page: Page,
  locator: Locator,
): Promise<SelectAnchorMeasurement['popup']> {
  let previous = await box(locator);
  await expect
    .poll(
      async () => {
        await page.waitForTimeout(60);
        const next = await box(locator);
        const settled =
          Math.abs(next.x - previous.x) < 0.5 &&
          Math.abs(next.y - previous.y) < 0.5 &&
          Math.abs(next.width - previous.width) < 0.5 &&
          Math.abs(next.height - previous.height) < 0.5;
        previous = next;
        return settled;
      },
      { message: 'the Select popup should settle after its opening animation' },
    )
    .toBe(true);
  return box(locator);
}

export async function expectSelectAnchored(
  page: Page,
  trigger: Locator,
  {
    sideOffset = 4,
    tolerance = 2,
    requireNoCollision = false,
  }: { sideOffset?: number; tolerance?: number; requireNoCollision?: boolean } = {},
): Promise<SelectAnchorMeasurement> {
  // Dialog/portal placement and scroll lock may briefly shift both boxes.
  // Retry the *original* settled geometry assertions, not their tolerances:
  // persistent drift, missing popup, and illegal collision still fail.
  let measurement: SelectAnchorMeasurement | undefined;
  await expect(async () => {
    const popup = page.locator('[data-slot="select-content"]:visible');
    await expect(popup).toBeVisible();
    await expect(popup).toHaveAttribute('data-align-trigger', 'false');

    const popupBox = await settledBox(page, popup);
    const triggerBox = await box(trigger);
    const viewport = page.viewportSize();
    if (!viewport) throw new Error('the page must have a viewport');

    const side = (await popup.getAttribute('data-side')) ?? '';
    expect(['bottom', 'top']).toContain(side);

    const dx = popupBox.x - triggerBox.x;
    const gap =
      side === 'bottom'
        ? popupBox.y - (triggerBox.y + triggerBox.height)
        : triggerBox.y - (popupBox.y + popupBox.height);

    // The start-aligned popup would overflow the viewport's start/end edge;
    // Base UI then shifts it. That displacement is the collision policy, not a
    // broken anchor, so the strict edge assertion only applies when it fits.
    const startAlignedOverflows =
      triggerBox.x < -tolerance ||
      triggerBox.x + popupBox.width > viewport.width + tolerance;
    const horizontalCollision = startAlignedOverflows || Math.abs(dx) > tolerance;
    if (requireNoCollision) {
      expect(
        startAlignedOverflows,
        'the fixture should leave room for a start-aligned popup at this viewport',
      ).toBe(false);
      expect(
        horizontalCollision,
        `popup start edge ${popupBox.x} should match trigger start edge ${triggerBox.x} by ≤${tolerance}px`,
      ).toBe(false);
    }

    if (horizontalCollision) {
      // The list must remain inside the viewport and still overlap the control
      // it belongs to; a shift that detaches it is not a valid collision repair.
      expect(popupBox.x).toBeGreaterThanOrEqual(-tolerance);
      expect(popupBox.x + popupBox.width).toBeLessThanOrEqual(viewport.width + tolerance);
      expect(popupBox.x).toBeLessThan(triggerBox.x + triggerBox.width);
      expect(popupBox.x + popupBox.width).toBeGreaterThan(triggerBox.x);
    }

    expect(
      Math.abs(gap - sideOffset),
      `popup ${side} gap should be sideOffset (${sideOffset}) ±${tolerance}px`,
    ).toBeLessThanOrEqual(tolerance);

    measurement = {
      trigger: triggerBox,
      popup: popupBox,
      dx,
      gap,
      side,
      horizontalCollision,
    };
  }).toPass({ timeout: 10_000, intervals: [100, 200, 400] });
  if (!measurement) throw new Error('Select popup has no settled measurement');
  return measurement;
}
