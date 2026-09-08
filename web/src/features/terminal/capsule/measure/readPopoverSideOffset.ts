/** Read popover side offset from experience composer token (px). */
export function readPopoverSideOffset(root: Element = document.documentElement): number {
  const raw = getComputedStyle(root).getPropertyValue('--composer-popover-side-offset').trim();
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : 8;
}
