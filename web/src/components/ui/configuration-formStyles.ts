/**
 * Shared surface styles for the Configuration Form recipe (issue 3137).
 *
 * A named section and its fields are separated by rhythm, not a fieldset
 * border. A repeated editable row (a location, a native Key/Value entry) is
 * grouped with the weakest useful cue — one background shift — so it reads as
 * one editable unit without becoming a card.
 *
 * Kept beside the component and separate from it so the module exports only
 * components (react-refresh).
 */
export const formRowClass =
  'flex min-w-0 flex-col gap-2 rounded-[var(--nession-radius-surface)] bg-muted/40 p-3';
