/**
 * Shared surface styles for the Resource / Capability Detail recipe (issue 3137).
 *
 * The recipe is whitespace-first (visual-language P7): a detail group is
 * separated by rhythm and alignment, not by a card, border, shadow or accent.
 * A row that is itself an action may gain a background shift on hover/focus,
 * because that shift communicates interactivity rather than grouping.
 *
 * Kept beside the component and separate from it so the module exports only
 * components (react-refresh), the same split `choice-itemStyles.ts` uses.
 */
export const detailRowClass =
  'flex min-w-0 items-center gap-2 rounded-[var(--nession-radius-surface)] px-2 py-1';

export const detailInteractiveRowClass =
  'flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-[var(--nession-radius-surface)] px-2 py-1 text-left transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-solid focus-visible:outline-[length:var(--nession-focus-ring-width)] focus-visible:outline-ring focus-visible:outline-offset-[calc(-1*var(--nession-focus-ring-offset))]';
