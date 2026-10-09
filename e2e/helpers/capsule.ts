import { expect, type Page } from '@playwright/test';

/**
 * Open a capability from the capsule's `+`.
 *
 * The list is one surface with two kinds of row (#1347 SC-35 as amended): a
 * capability the session senses right now is listed first under its own name
 * (`capsule-context-item-…`, with a reason), everything else follows under the
 * picker name (`capsule-capability-picker-…`). A spec says *which capability*
 * it wants; which half of the list that capability lands in is the product's
 * business — it depends on the experience (Terminal Keys is sensed on App and
 * ordinary on Web) and on what is running.
 *
 * Two things this deliberately does not do. It does not assume a step: the
 * two-layer disclosure it was written for had an `All capabilities` submenu,
 * and a helper that still looked for one would wait forever now. And it does
 * not ask the DOM what shape it has before the surface has mounted — a
 * `count()` immediately after the click reads an empty tree, and the click that
 * follows then times out on a row that was always going to appear (#1441).
 *
 * What the row leads to is now the same either way: every row opens its
 * capability's Peek, so a caller does not have to know which half it landed in
 * to know where it ended up. That was not true before — a sensed row opened the
 * Peek while an ordinary one opened a Signal, and the specs that followed this
 * helper carried an extra title click to make up the difference. The two rows
 * still differ (only a sensed one shows a reason line), but their destination
 * does not, so callers can drop that click.
 */
export async function openCapsuleCapability(page: Page, id: string): Promise<void> {
  await page.getByTestId('capsule-capability-more').click();

  const row = page
    .getByTestId(`capsule-capability-picker-${id}`)
    .or(page.getByTestId(`capsule-context-item-${id}`));

  await expect(row.first()).toBeVisible();
  await row.first().click();
}
