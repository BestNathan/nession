import { expect, type Page } from '@playwright/test';

/**
 * Open a capability from the capsule's `+`, wherever the surface puts it.
 *
 * Two things about the Context Disclosure make a spec's guess about *which* row
 * it will find wrong half the time, and both are load-bearing product behaviour
 * rather than test noise:
 *
 * - **The experience decides the shape.** Terminal Keys is context-sensed on App
 *   with a Session (#1347 SC-37) and an ordinary entry everywhere else — so a
 *   spec that names the App row times out on Web's default viewport, and one
 *   that names the ordinary row has to take a step on App.
 * - **The surface mounts asynchronously.** Asking the DOM what shape it has
 *   immediately after the click reads an empty tree: `count()` returns 0, the
 *   helper skips a step it should have taken, and the click that follows waits
 *   out its 30s timeout for a row behind that step. Measured on CI: the same
 *   three cases pass or time out depending on how fast the popup mounts.
 *
 * So the shape is discovered by *waiting for whichever layer arrived first*,
 * and the id is opened from the layer that is actually there. It lives here
 * rather than beside the fixture routes because both the fixture specs and the
 * real-stack terminal specs drive the same control.
 */
export async function openCapsuleCapability(page: Page, id: string): Promise<void> {
  await page.getByTestId('capsule-capability-more').click();

  // Whichever surface arrived: the ordinary rows when nothing is sensed, or the
  // sensed list — whose ordinary rows sit one step down behind `All
  // capabilities` while a sense is active.
  const picker = page.getByTestId(`capsule-capability-picker-${id}`);
  const all = page.getByTestId('capsule-context-all');
  await expect(all.or(picker).first()).toBeVisible();

  if (await all.isVisible()) {
    await all.click();
  }
  await picker.click();
}
