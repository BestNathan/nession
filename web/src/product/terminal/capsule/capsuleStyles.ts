/**
 * Capsule composer presentation classes — token vars only, no numeric Tailwind scale.
 * This file is the sole bridge from design tokens to Tailwind class strings in capsule/.
 *
 * ── Naming: the binding name states the experience ──────────────────────────
 *
 * A class that may only be applied under the App experience carries an `App`
 * marker in its binding name; one that only applies on Web carries `Web` (or is
 * the unmarked sibling of an App-marked pair):
 *
 *   capsuleShellWebOuterClass      → var(--terminal-capsule-shell-margin-x)   (web-only)
 *   capsuleShellAppOuterClass      → var(--terminal-capsule-shell-inset)      (app-only)
 *
 * This is not decoration. The two experiences are asymmetric: `emitAppExperienceRemap`
 * writes every app leaf into `[data-experience="app"]`, while web leaves go to
 * `:root`. An app-only token therefore resolves to *nothing* outside the App
 * experience — the declaration is dropped and the layout collapses silently —
 * whereas a web-only token resolves in both. So an app-only token in a class
 * that reaches Web is a real defect, and the marker is what lets
 * `nession/no-cross-experience-token` decide that statically: whether an element
 * renders on Web is a runtime property of the component tree, but the binding
 * name is the author's own statement of it.
 */
import { cn } from '@/shared/lib/utils';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
import type { CapsuleExperience, ComposerLayout } from '@/product/terminal/capsule/types';

/** Shared by textarea + ghost overlay so glyphs stay locked. */
export const capsuleFieldTypeClass =
  'font-sans text-[length:var(--terminal-capsule-font-size)] leading-[length:var(--terminal-capsule-text-line-height)] antialiased';

export const capsuleFieldPadClass =
  'px-[length:var(--terminal-capsule-field-inset-x)] py-[length:var(--terminal-capsule-field-inset-y)]';

/**
 * Every capsule control's **hit target** — one size, no primary/secondary split.
 *
 * A capsule control has two axes, and they are deliberately different objects:
 *
 *   hit target        this class        `control.md`  — 44px on App (the tap
 *                                                       floor), 32px on Web
 *   drawn affordance  the inner visual  `control.visualSize` — 36px on App, 32px
 *                                       on Web (#1034)
 *
 * The split exists because a 44px *tap target* is correct while 44px of *painted*
 * geometry makes every icon action read as a primary button. It is expressed as
 * two DOM nodes rather than one class, because every assertion that measures a
 * control — `expectTokenHeight`, `expectTouchTarget` — measures the element it
 * is handed, so a smaller painting inside the same box is only measurable on a
 * second node.
 *
 * There used to be a `capsuleSecondaryIconButtonClass` alongside this one,
 * documented as "smaller band so the field keeps width". It was applied in the
 * field-first layout and never in the single-row layout that actually trades
 * against the field, so it bought no width anywhere. It was also a smaller *hit
 * target*, which is the opposite of what is wanted here — and it contradicted
 * the contract, which names `control.md` as the band for both experiences
 * (`pattern.terminal-capsule`). Nothing caught that, because on App `control.sm`
 * and `control.md` are both 44px: the contract records the token *and* the
 * resolved px, and the matrix only measures the px, so any future divergence
 * would have reopened the sub-44px tap target silently. **This is not a return
 * to that class.** The hit target stays `control.md` here and is asserted on
 * this element; only the painting moved inside it.
 *
 * This string is read by `design-gate.mjs` (`checkCapsuleSemanticBridge`), which
 * requires its first `var(--control-…)` to be the contract's band. Do not fold
 * the visual into it with `cn()` — that would make the check read the wrong
 * token and put the drawn affordance under the hit target's guarantee.
 */
export const capsuleIconButtonClass =
  "h-[length:var(--control-md)] w-[length:var(--control-md)] shrink-0 touch-manipulation [&_svg:not([class*='size-'])]:size-[length:var(--icon-md)]";

/**
 * The **drawn affordance** inside a capsule control — the circle a caller paints.
 *
 * Split from `capsuleIconButtonClass` so the painted geometry can be smaller than
 * the box that receives the tap (#1034) without either one losing its own
 * guarantee: this class carries no hit area, and the control class carries no
 * paint. Paint is the caller's, through `CapsuleIconVisual`'s `className`: send
 * paints it continuously, because it is the primary action; the secondary
 * actions leave it unpainted, and it is the geometry their state paint belongs
 * on if they ever gain one — a state painted on the control would fill the hit
 * target and undo the split.
 *
 * `size-[length:var(--control-visual-size)]` is the only metric here, and it is
 * the token the contract names (`visualSizeToken`), which is what lets
 * `design-gate.mjs` fail if the two drift apart. `var(--control-visual-size)`
 * resolves on both experiences: the leaf is declared in `experience.web` as well
 * as `experience.app`, so `:root` defines it and `[data-experience="app"]`
 * remaps it.
 */
export const capsuleIconVisualClass =
  'flex size-[length:var(--control-visual-size)] shrink-0 items-center justify-center rounded-full';

export const capsuleControlRowClass =
  'relative z-[1] flex h-[length:var(--control-md)] shrink-0 items-center gap-[length:var(--terminal-capsule-control-gap)]';

/** Floating control surface — the shared elevation, no border (visual-language.md
 *  "several floating surfaces ... must read as one group", terminal-capsule.md
 *  § Surface treatment). Every Nession-owned floating surface uses this token;
 *  a surface that needs its own shadow is evidence it should not be floating. */
export const capsuleFloatingSurfaceClass =
  'bg-[color:var(--terminal-capsule-surface)] text-foreground shadow-[var(--elevation-floating)] backdrop-blur-md';

export const capsuleShellSurfaceClass = capsuleFloatingSurfaceClass;

export const capsuleShellInnerPadClass =
  'px-[length:var(--terminal-capsule-shell-pad-x)] py-[length:var(--terminal-capsule-shell-pad-y)]';

/** Stacked / multi-row shell corners */
export const capsuleShellCapsuleRadiusClass = 'rounded-[var(--radius-capsule)]';

/** Single-row web pill ends */
export const capsuleShellPillRadiusClass = 'rounded-[var(--terminal-capsule-shell-pill-radius)]';

/**
 * The one derivation of a Capsule's outer geometry (#1347 SC-29/SC-30).
 *
 * The Conversation Form and the Capability Form are one object in two states,
 * and the relational assertion that keeps them so compares their *rendered*
 * geometry — so their class lists have to come from one place. They were written
 * twice, which is how the Capability Form kept a 9999px pill and the retired
 * 28px dock band for as long as it did: each site was self-consistent, and only
 * a comparison *between* them could see the drift.
 *
 * Shared: the control band's vertical mass, the surface treatment, the radius
 * family (the shape picks which), the inner padding rhythm, the hit area, and
 * the clipping that keeps a scrolling child inside the corners.
 *
 * Not shared: **width**. The Terminal shell is stretched by its dock; the
 * Workspace nav shares a row with the Web surface action and sizes to its own
 * content inside the bar. That is a fact about each one's parent rather than
 * about the Capsule, so it stays a parameter — and it is why the relational
 * assertion compares where each one *lands* (its insets) instead of the width
 * either one declares.
 */
export interface CapsuleOuterGeometry {
  shape: 'capsule' | 'pill';
  shellClass: string;
}

export function capsuleOuterGeometry(
  experience: CapsuleExperience,
  layout: ComposerLayout = 'flat',
  width: 'stretch' | 'intrinsic' = 'stretch',
): CapsuleOuterGeometry {
  const shape: CapsuleOuterGeometry['shape'] =
    experience === 'app' || layout !== 'flat' ? 'capsule' : 'pill';

  return {
    shape,
    // Plain strings, one axis each, so the whole object reads at once. They
    // cannot collide: the shape picks exactly one radius, and the width is
    // exactly one of the two.
    shellClass: [
      'pointer-events-auto flex min-h-[length:var(--control-md)] items-center overflow-hidden',
      width === 'stretch' ? 'w-full' : 'max-w-full',
      capsuleShellSurfaceClass,
      shape === 'pill' ? capsuleShellPillRadiusClass : capsuleShellCapsuleRadiusClass,
      capsuleShellInnerPadClass,
    ].join(' '),
  };
}

/**
 * Web outer frame — margins, then a bound, then centred.
 *
 * `mx-auto` is what centres it: both insets are pinned, so the element's used
 * width is `min(available, max-width)` and the leftover is split evenly between
 * the two auto margins. Without the bound the capsule simply filled the
 * viewport minus margins — ~84rem on a 1440px screen — while
 * `terminal-capsule.md` §Web vs App says the Web capsule is *"usually centered
 * with a bounded max width"*, and `experience.web.terminalCapsule.shellMaxWidth`
 * (42rem, owned by `pattern.terminal-capsule`) sat unused. The token and the
 * config field both existed; only the render omitted them. The doc is upstream
 * here, so the code was the convergence debt.
 */
export const capsuleShellWebOuterClass =
  'inset-x-[length:var(--terminal-capsule-shell-margin-x)] max-w-[length:var(--terminal-capsule-shell-max-width)] mx-auto flex flex-col items-stretch pointer-events-none';

export const capsuleShellAppOuterClass =
  'inset-x-[length:var(--terminal-capsule-shell-inset)] flex justify-center pointer-events-none';

export const capsuleShellDockBottomClass =
  'bottom-[max(var(--terminal-capsule-shell-margin-bottom),env(safe-area-inset-bottom))]';

export const capsuleShellAppDockBottomClass =
  'bottom-[max(var(--terminal-capsule-shell-inset),var(--terminal-capsule-shell-safe-area))]';

/**
 * The upper Context Capsule (#1347 SC-41–44) — the second surface in the dock,
 * above the shell.
 *
 * Its gap is a margin rather than a positioned offset, which is what makes "the
 * lower Capsule does not move" structural: the dock is a bottom-anchored
 * `flex flex-col`, so growing upward cannot move what is below it, and the gap
 * is the one token between them.
 */
export const contextCapsuleDockClass = 'mb-[length:var(--context-capsule-margin-bottom)]';

/**
 * The surface itself: the shell's own treatment (one Capsule language), a height
 * CEILING rather than a height, and clipping so the scrolling row inside cannot
 * paint past the corners.
 *
 * It takes its content's height and clamps only at the ceiling, so a list of
 * three capabilities is three rows tall instead of reserving the rows it does
 * not have. SC-44 still holds, but no longer by construction: the flat list
 * renders every capability, so the three sense states differ in row *order* and
 * never in row *count* — which is why the pair does not resize as senses come
 * and go. That invariant is asserted rather than assumed (the contract's
 * `maxHeightToken` plus the equal-height comparison across states).
 *
 * The radius is `semantic.radius-capsule` on both experiences rather than the
 * Web shell's pill: a pill radius is what a 32px one-row box wears, and this is
 * a multi-row surface. It is also what `pattern.context-capsule` pins.
 */
export const contextCapsuleSurfaceClass = [
  'pointer-events-auto flex max-h-[length:var(--context-capsule-max-height)] w-full flex-col overflow-hidden',
  'rounded-[var(--radius-capsule)]',
  // The surface carries the padding, not the rows: `pattern.context-capsule`
  // pins `padXToken` here, and it is what insets a row's hover and focus ring
  // from the Capsule's own edge instead of painting them against it.
  'px-[length:var(--terminal-capsule-shell-pad-x)] py-[length:var(--terminal-capsule-shell-pad-y)]',
  capsuleShellSurfaceClass,
].join(' ');

/** The list owns its scroll and hands every other gesture back (SC-42). */
export const contextCapsuleScrollClass = 'min-h-0 flex-1 overflow-y-auto overscroll-contain';

/**
 * One row: a whole-row control, two lines tall by design (title + reason), with
 * the icon slot reserved whether or not a glyph arrived so the titles stay
 * aligned down the list.
 *
 * `min-h` is a floor, so the band is only uniform if both lines fit inside it —
 * that is a rule about the pair, not about the box. It once needed a
 * capsule-local leading to hold: with only a font-size set, both lines inherited
 * the document's 1.5, and at the capsule's own 1rem text the pair measured 48px
 * against the 44px band, so a sensed row stood 4px prouder than an ordinary one
 * and the list's rhythm changed with the sense state. The pair fits now because
 * of the role *sizes*: 14 + 11.5 at the same inherited 1.5 is 38.25px (Web 36px),
 * already inside the band, and the role leadings only tighten that to 34.55px /
 * 31.85px. The leading is still what retires `rowLineHeight` — the roles supply
 * one, so a capsule-local one would be a second answer to a question already
 * answered — but the band does not depend on it.
 */
export const contextCapsuleRowClass = [
  'flex w-full min-h-[length:var(--context-capsule-row-height)] items-center gap-[length:var(--terminal-capsule-control-gap)]',
  'rounded-[var(--radius-control)] text-left transition-colors',
  // `ring-inset`, because a row is full-bleed inside a scrolling container: an
  // outset ring is clipped on every side but the last row's, which drew a stray
  // underline under the first row when focus moved into the list (caught in the
  // screenshot, invisible to every assertion about the row's box).
  'hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
].join(' ');

/** The icon column, present even when empty so titles share one edge. */
export const contextCapsuleIconSlotClass = 'flex size-[length:var(--icon-md)] shrink-0 items-center justify-center';

/**
 * The presence mark's column, and the mark inside it.
 *
 * The column is always present so titles share one edge whether or not a dot is
 * drawn; the mark is drawn only for a capability the session actually needs
 * (`relevant` / `active`), which is the same rule the Capability Form's entries
 * follow.
 */
export const contextCapsuleMarkerSlotClass =
  'flex size-[length:var(--context-capsule-marker-size)] shrink-0 justify-center';

export const contextCapsuleMarkerClass =
  'size-[length:var(--context-capsule-marker-size)] rounded-full bg-foreground';

/**
 * The row's two lines, set in the design language's roles rather than the
 * capsule's own font size.
 *
 * Both classes used to name `--terminal-capsule-font-size` /
 * `--terminal-capsule-caption-font-size`, and **both of those leaves ref the
 * one `primitive.typography.size`** — so on both experiences they emitted the
 * same 16px, the title and the reason were separated by colour alone, and the
 * list carried no typographic hierarchy at all (measured line by line on
 * staging 2026-10-04: all four rows' initial cap height was 12px). The design
 * language keeps a ramp for exactly this job, and the row was using none of it.
 *
 * `body` is the role written for it — the role's note on Web names "button
 * labels, menu items, filters" — and the reason takes `caption`. The roles
 * supply the leading too, which is what retires `contextCapsule.rowLineHeight`:
 * the pair was already inside the band on the role sizes (14 + 11.5 at the
 * inherited 1.5 is 38.25px on App, 36px on Web), so what a capsule-local leading
 * would duplicate is the roles' own answer, not the fit — the role leadings only
 * tighten the pair to 34.55px / 31.85px.
 */
export const contextCapsuleTitleClass = cn('truncate text-foreground', chromeSansRole('body'));

export const contextCapsuleReasonClass = cn(
  'truncate text-muted-foreground',
  chromeSansRole('caption'),
);

export const capsuleComposerGridGapClass = 'gap-[length:var(--terminal-capsule-row-gap)]';

export const capsuleComposerRowGapYClass = 'gap-y-[length:var(--terminal-capsule-toolbar-row-gap)]';

export const capsuleShellContentGapClass = 'gap-[length:var(--terminal-capsule-shell-content-gap)]';

export const capsulePopoverPanelClass =
  'z-[length:var(--terminal-capsule-popover-zindex)] max-h-[length:var(--terminal-capsule-popover-max-height)] w-[length:var(--terminal-capsule-popover-width)] max-w-[calc(100vw-var(--terminal-capsule-popover-viewport-inset))] overflow-hidden border-border bg-popover p-0 text-popover-foreground shadow-md';

export const capsulePopoverHeaderClass =
  'gap-[length:var(--terminal-capsule-popover-gap)] border-b border-border/60 p-[length:var(--terminal-capsule-popover-pad)]';

export const capsulePopoverScrollClass =
  'max-h-[length:var(--terminal-capsule-popover-list-max-height)] overflow-y-auto p-[length:var(--terminal-capsule-popover-inner-pad)]';

export const capsulePopoverBodyClass =
  'flex max-h-[length:var(--terminal-capsule-popover-body-max-height)] flex-col overflow-hidden';

export const capsulePopoverItemClass =
  'flex h-[length:var(--control-md)] w-full items-center gap-[length:var(--terminal-capsule-popover-gap)] px-[length:var(--terminal-capsule-popover-item-pad-x)] text-left text-[length:var(--terminal-capsule-font-size)] transition-colors hover:bg-accent/40 disabled:opacity-50';

export const capsuleCaptionTextClass = 'text-[length:var(--terminal-capsule-caption-font-size)]';

export const capsulePopoverSearchClass =
  'h-[length:var(--control-md)] text-[length:var(--terminal-capsule-font-size)]';

export const capsuleEmptyStatePadClass =
  'px-[length:var(--terminal-capsule-phys-key-pad-x)] py-[length:var(--terminal-capsule-dialog-gap)] text-[length:var(--terminal-capsule-font-size)]';

export const capsuleHistoryItemClass =
  'flex w-full items-center justify-between gap-[length:var(--terminal-capsule-popover-gap)] rounded px-[length:var(--terminal-capsule-phys-key-pad-x)] py-[length:var(--terminal-capsule-phys-key-pad-x)] text-left text-[length:var(--terminal-capsule-font-size)] hover:bg-accent/40';

export const capsulePhysKeyButtonClass =
  'h-[length:var(--terminal-capsule-phys-key-height)] min-w-[5ch] shrink-0 whitespace-nowrap px-0 font-mono text-[length:var(--terminal-capsule-phys-key-font-size)]';

export const capsuleArrowKeyAppButtonClass =
  'h-[length:var(--terminal-capsule-phys-key-height)] w-[var(--terminal-capsule-phys-key-arrow-width)] min-w-0 shrink-0 px-0 font-mono text-[length:var(--terminal-capsule-phys-key-font-size)]';

export const capsulePhysKeyIconClass = 'size-[length:var(--terminal-capsule-phys-key-icon-size)]';

export const capsulePhysKeyRowClass =
  'flex flex-row items-center gap-[length:var(--terminal-capsule-phys-key-grid-gap)] border-b border-border/60 px-[length:var(--terminal-capsule-phys-key-pad-x)] py-[length:var(--terminal-capsule-phys-key-pad-y)]';

export const capsulePhysKeyGridGapClass = 'gap-[length:var(--terminal-capsule-phys-key-grid-gap)]';

export const capsuleChainBarClass =
  'flex items-center gap-[length:var(--terminal-capsule-popover-gap)] border-b border-border/60 bg-primary/10 px-[length:var(--terminal-capsule-phys-key-pad-x)] py-[length:var(--terminal-capsule-popover-inner-pad)] text-[length:var(--terminal-capsule-font-size)]';

export const capsuleMiniButtonClass =
  'h-[length:var(--terminal-capsule-mini-control-height)] text-[length:var(--terminal-capsule-caption-font-size)]';

export const capsuleChipRowClass = 'flex flex-wrap gap-[length:var(--terminal-capsule-chip-gap)]';

export const capsuleLabelTextClass =
  'shrink-0 text-[length:var(--terminal-capsule-font-size)] text-muted-foreground';

export const capsuleInlineFieldRowClass =
  'flex items-center gap-[length:var(--terminal-capsule-popover-gap)]';

/**
 * An emerged capability projection — the Peek frame (`#826`).
 *
 * Its own token group rather than borrowed popover values: a projection is a
 * smaller, less permanent surface than a popover, and pointing at the popover's
 * geometry would have made the two move together for no reason. The typography
 * is a step below the capsule's own scale, because a Peek that arrived at the
 * composer's text size would read as a second composer.
 *
 * **The radius is the capsule's** (owner decision, 2026-10-04). It has been
 * three different values on the way here: `var(--radius-lg)`, the generic
 * shadcn-scale corner a menu or a card also wears; then
 * `terminalCapsule.projectionRadius`, a leaf declared in both experience files
 * for exactly this frame; now `radius-capsule`, the same token the resting
 * capsule below it resolves.
 *
 * That last step is the point. The Peek does not sit beside the capsule — it
 * takes the capsule's slot, one gap above it, and a surface that replaces
 * another in place reads as a *different family* when its corner does not
 * match. 12px against 22px was visible; the 2px between this and the
 * `radius-floating` tier the hierarchy had assigned the Peek was not. So the
 * hierarchy changed rather than the value being nudged: `radius-floating` is
 * deleted (its one documented consumer was this frame), and the capsule tier
 * now covers the capsule and the surface that stands in for it.
 */
export const capsuleProjectionClass =
  'pointer-events-auto flex flex-col gap-[length:var(--terminal-capsule-projection-gap)] rounded-[var(--radius-capsule)] border border-border/60 bg-background/95 p-[length:var(--terminal-capsule-projection-pad)] shadow-[var(--elevation-floating)] backdrop-blur';

/** Above the capsule, never over it: the resting capsule's box does not move. */
export const capsuleProjectionDockClass =
  'mb-[length:var(--terminal-capsule-projection-margin-bottom)]';

/**
 * The ceiling, and it scrolls its own overflow (#826 Q5).
 *
 * A projection is a small surface floating over the work; it stops well short of
 * the terminal and never becomes the thing that owns the scroll.
 */
export const capsuleProjectionScrollClass =
  'max-h-[length:var(--terminal-capsule-projection-max-height)] overflow-y-auto';

export const capsuleProjectionTextClass =
  'font-sans text-[length:var(--terminal-capsule-projection-font-size)] leading-[length:var(--terminal-capsule-projection-line-height)]';

export const capsuleProjectionItemClass =
  'flex w-full items-center gap-[length:var(--terminal-capsule-projection-item-gap)] rounded px-[length:var(--terminal-capsule-projection-item-pad-x)] py-[length:var(--terminal-capsule-projection-item-pad-y)] text-left transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/** The change letter's column, fixed so the filenames beside it share an edge. */
export const capsuleProjectionMarkClass =
  'w-[length:var(--terminal-capsule-projection-mark-width)] shrink-0 font-mono';
