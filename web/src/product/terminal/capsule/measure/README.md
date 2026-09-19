# `measure/` — implementation asset, not the product boundary

Everything in this directory reads **resolved CSS** at runtime to decide geometry:
how many lines the composer will soft-wrap to, how tall the capsule will be, how
far a popover must offset, and how much vertical room the dock needs.

`docs/design/design-system/patterns/terminal-capsule.md` §Implementation
migration asks that `InputComposer`, `CommandsComposer`, "terminal quick keys,
and related contracts" be treated as **implementation assets to converge rather
than as the permanent product boundary". This directory is one of those assets,
and it is the easiest one to mistake for product: its files are named after
what they compute (`layoutFromLineCount`, `measureLineCount`) rather than after
anything a user would recognise.

The product requirement it serves is the pattern doc's *"stable geometry during
state changes"* (§Visual contract, Quality through precision) — measuring is how
that is achieved, not what it means.

## Consequences for anyone changing it

- **Names here are implementation names.** They do not participate in the
  `terminal-capsule` token vocabulary, and the #825 rename deliberately stopped
  at the design-system layer: `data-testid="capsule-composer-measure-mirror"`
  keeps its name because it belongs to this subsystem, not to the design system.
  (That boundary was broken once during the rename and caught by
  `InputComposer.test.tsx`.)
- **Tokens are read by name.** `readComposerMetrics` does
  `getPropertyValue('--terminal-capsule-…')` against the generated CSS, so a
  token rename in `design/tokens/` reaches into here. The
  `no-capsule-magic-metrics` rule guards its own token names against exactly
  that (see `every token the rule names still exists in the generated CSS`);
  these reads are covered by `readComposerMetrics`' own tests.
- **Measuring is not styling.** If you came here to change how the capsule
  *looks*, the owner is the token source and `capsuleStyles.ts`; this directory
  only decides *how much room* things take.
