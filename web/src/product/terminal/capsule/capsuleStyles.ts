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

/** Shared by textarea + ghost overlay so glyphs stay locked. */
export const capsuleFieldTypeClass =
  'font-sans text-[length:var(--terminal-capsule-font-size)] leading-[length:var(--terminal-capsule-text-line-height)] antialiased';

export const capsuleFieldPadClass =
  'px-[length:var(--terminal-capsule-field-inset-x)] py-[length:var(--terminal-capsule-field-inset-y)]';

/**
 * Every capsule control — one size, no primary/secondary split.
 *
 * There used to be a `capsuleSecondaryIconButtonClass` alongside this one,
 * documented as "smaller band so the field keeps width". It was applied in the
 * field-first layout and never in the single-row layout that actually trades
 * against the field, so it bought no width anywhere.
 *
 * It also contradicted the contract, which names `control.md` as the band for
 * both experiences (`pattern.terminal-capsule`). Nothing caught that, because
 * on App `control.sm` and `control.md` are both 44px — the contract records
 * the token *and* the resolved px, and the matrix only measures the px. Any
 * future divergence reopens the sub-44px tap target silently. One class, named
 * by the contract, is the whole fix.
 */
export const capsuleIconButtonClass =
  "h-[length:var(--control-md)] w-[length:var(--control-md)] shrink-0 touch-manipulation [&_svg:not([class*='size-'])]:size-[length:var(--icon-md)]";

export const capsuleControlRowClass =
  'relative z-[1] flex h-[length:var(--control-md)] shrink-0 items-center gap-[length:var(--terminal-capsule-control-gap)]';

/** Dialog layer above composer popovers (--terminal-capsule-popover-zindex is 100). */
export const capsuleDialogContentClass = 'z-[110]';

export const capsuleCommandsPanelClass =
  'flex h-full min-h-0 flex-col overflow-hidden bg-popover text-popover-foreground';

export const capsuleCommandsAppOverlayPanelClass =
  'pointer-events-auto absolute inset-x-[length:var(--terminal-capsule-shell-inset)] z-[15] flex flex-col overflow-hidden rounded-t-xl border border-border/60 bg-popover text-popover-foreground shadow-lg';

export const capsuleCommandsPanelKeysRegionClass =
  'flex min-h-0 flex-1 flex-col justify-center border-b border-border/60';

export const capsuleCommandsPanelCommandsRegionClass =
  'flex min-h-0 flex-1 flex-col overflow-hidden';

export const capsuleCommandsPanelHeaderClass =
  'flex shrink-0 items-center justify-end gap-[length:var(--terminal-capsule-popover-gap)] px-[length:var(--terminal-capsule-popover-pad)] pt-[length:var(--terminal-capsule-popover-inner-pad)]';

export const capsuleCommandsPanelListClass =
  'min-h-0 flex-1 overflow-y-auto';

export const capsuleCommandsDismissLayerClass =
  'absolute inset-x-0 top-0 z-10 cursor-default';

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

/** Inner (interactive) shell: full-width, clips children to the capsule corners. */
export const capsuleShellInnerClass =
  'pointer-events-auto w-full overflow-hidden';

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

export const capsuleQuickKeyAppButtonClass =
  'shrink-0 rounded-[calc(var(--radius-capsule)/2)] px-[length:var(--terminal-capsule-quick-key-pad-x)] font-mono text-[length:var(--terminal-capsule-quick-key-font-size)] leading-none text-muted-foreground min-h-[length:var(--control-md)] min-w-[length:var(--control-sm)] hover:bg-accent/50 hover:text-foreground active:bg-accent/70 data-pressed:bg-accent/60';

export const capsuleQuickKeyAppRowClass =
  'gap-[length:var(--terminal-capsule-quick-key-gap)]';

export const capsuleModeToggleGroupClass =
  'gap-[length:var(--terminal-capsule-control-gap)]';

export const capsuleModeToggleItemActiveClass =
  'bg-accent/60 text-foreground';

export const capsuleCommandsRowClass =
  'flex min-w-0 flex-1 items-center';

export const capsuleCommandsScrollClass =
  'flex min-w-0 flex-1 items-center overflow-x-auto scrollbar-none';

export const capsuleCommandsMoreClass =
  'shrink-0';

export const capsuleDialogStackClass = 'flex flex-col gap-[length:var(--terminal-capsule-dialog-gap)]';

export const capsuleChipRowClass = 'flex flex-wrap gap-[length:var(--terminal-capsule-chip-gap)]';

export const capsuleChipButtonClass =
  'h-[length:var(--control-md)] px-[length:var(--terminal-capsule-popover-item-pad-x)] text-[length:var(--terminal-capsule-font-size)]';

export const capsuleKeyInputClass =
  'h-[length:var(--control-md)] w-[length:var(--terminal-capsule-key-input-width)] text-center font-mono text-[length:var(--terminal-capsule-font-size)]';

export const capsuleDialogInputClass =
  'h-[length:var(--control-md)] text-[length:var(--terminal-capsule-font-size)]';

export const capsuleDialogActionRowClass =
  'flex justify-end gap-[length:var(--terminal-capsule-popover-gap)]';

export const capsuleDialogMaxWidthClass = 'max-w-[length:var(--terminal-capsule-dialog-max-width)]';

export const capsuleTabRowClass =
  'mb-[length:var(--terminal-capsule-dialog-gap)] flex gap-[length:var(--terminal-capsule-chip-gap)]';

export const capsuleTabButtonClass =
  'h-[length:var(--terminal-capsule-tab-height)] px-[length:var(--terminal-capsule-popover-inner-pad)] text-[length:var(--terminal-capsule-font-size)]';

export const capsuleIconCloseButtonClass =
  'h-[length:var(--terminal-capsule-icon-close-size)] w-[length:var(--terminal-capsule-icon-close-size)] shrink-0 text-muted-foreground hover:text-destructive';

export const capsuleAddCommandFooterClass =
  'h-[length:var(--control-md)] w-full rounded-none text-[length:var(--terminal-capsule-font-size)]';

export const capsuleAddCommandIconClass =
  'mr-[length:var(--terminal-capsule-popover-inner-pad)] size-[length:var(--terminal-capsule-phys-key-icon-size)]';

export const capsuleIconCloseSvgClass = 'size-[length:var(--terminal-capsule-phys-key-icon-size)]';

export const capsuleLabelTextClass =
  'shrink-0 text-[length:var(--terminal-capsule-font-size)] text-muted-foreground';

export const capsuleInlineFieldRowClass =
  'flex items-center gap-[length:var(--terminal-capsule-popover-gap)]';

export const capsuleModeToggleItemClass =
  'min-h-[length:var(--control-md)] min-w-[length:var(--control-md)] [&_svg]:size-[length:var(--icon-md)]';

/**
 * An emerged capability projection — the Signal and Peek frame (`#826`).
 *
 * Its own token group rather than borrowed popover values: a projection is a
 * smaller, less permanent surface than a popover, and pointing at the popover's
 * geometry would have made the two move together for no reason. The typography
 * is a step below the capsule's own scale, because a Signal that arrived at the
 * composer's text size would read as a second composer.
 */
export const capsuleProjectionClass =
  'pointer-events-auto flex flex-col gap-[length:var(--terminal-capsule-projection-gap)] rounded-[var(--radius-lg)] border border-border/60 bg-background/95 p-[length:var(--terminal-capsule-projection-pad)] shadow-[var(--elevation-floating)] backdrop-blur';

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
