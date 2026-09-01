/**
 * Capsule composer presentation classes — token vars only, no numeric Tailwind scale.
 * This file is the sole bridge from design tokens to Tailwind class strings in capsule/.
 */

/** Shared by textarea + ghost overlay so glyphs stay locked. */
export const capsuleFieldTypeClass =
  'font-sans text-[length:var(--composer-font-size)] leading-[length:var(--composer-text-line-height)] antialiased';

export const capsuleFieldPadClass =
  'px-[length:var(--composer-field-inset-x)] py-[length:var(--composer-field-inset-y)]';

/** Primary actions (Send) — full touch/control band. */
export const capsuleIconButtonClass =
  "h-[length:var(--control-md)] w-[length:var(--control-md)] shrink-0 [&_svg:not([class*='size-'])]:size-[length:var(--icon-md)]";

/** Secondary toolbar icons — smaller band so the field keeps width. */
export const capsuleSecondaryIconButtonClass =
  "h-[length:var(--control-sm)] w-[length:var(--control-sm)] shrink-0 [&_svg:not([class*='size-'])]:size-[length:var(--icon-sm)]";

export const capsuleControlRowClass =
  'flex h-[length:var(--control-md)] shrink-0 items-center gap-[length:var(--composer-control-gap)]';

export const capsuleShellSurfaceClass =
  'border border-border bg-[color:var(--terminal-capsule-surface)] text-foreground shadow-lg backdrop-blur-sm';

export const capsuleShellInnerPadClass =
  'px-[length:var(--composer-shell-pad-x)] py-[length:var(--composer-shell-pad-y)]';

export const capsuleShellRadiusClass = 'rounded-[length:var(--radius-capsule)]';

export const capsuleComposerGridGapClass = 'gap-[length:var(--composer-row-gap)]';

export const capsuleComposerRowGapYClass = 'gap-y-[length:var(--composer-toolbar-row-gap)]';

export const capsuleShellWebPositionClass =
  'left-1/2 w-[min(calc(100%-var(--composer-shell-margin-x)-var(--composer-shell-margin-x)),var(--composer-shell-max-width))] -translate-x-1/2 bottom-[max(var(--composer-shell-margin-bottom),env(safe-area-inset-bottom))]';

export const capsuleShellContentGapClass = 'gap-[length:var(--composer-shell-content-gap)]';

export const capsulePopoverPanelClass =
  'z-[length:var(--composer-popover-z-index)] max-h-[length:var(--composer-popover-max-height)] w-[length:var(--composer-popover-width)] overflow-hidden border-border bg-popover p-0 text-popover-foreground shadow-md';

export const capsulePopoverHeaderClass =
  'gap-[length:var(--composer-popover-gap)] border-b border-border/60 p-[length:var(--composer-popover-pad)]';

export const capsulePopoverScrollClass =
  'max-h-[length:var(--composer-popover-list-max-height)] overflow-y-auto p-[length:var(--composer-popover-inner-pad)]';

export const capsulePopoverBodyClass =
  'flex max-h-[length:var(--composer-popover-body-max-height)] flex-col overflow-hidden';

export const capsulePopoverItemClass =
  'flex h-[length:var(--control-md)] w-full items-center gap-[length:var(--composer-popover-gap)] px-[length:var(--composer-popover-item-pad-x)] text-left text-[length:var(--composer-font-size)] transition-colors hover:bg-accent/40 disabled:opacity-50';

export const capsuleCaptionTextClass = 'text-[length:var(--composer-caption-font-size)]';

export const capsulePopoverSearchClass =
  'h-[length:var(--control-md)] text-[length:var(--composer-font-size)]';

export const capsuleEmptyStatePadClass =
  'px-[length:var(--composer-phys-key-pad-x)] py-[length:var(--composer-dialog-gap)] text-[length:var(--composer-font-size)]';

export const capsuleHistoryItemClass =
  'flex w-full items-center justify-between gap-[length:var(--composer-popover-gap)] rounded px-[length:var(--composer-phys-key-pad-x)] py-[length:var(--composer-phys-key-pad-x)] text-left text-[length:var(--composer-font-size)] hover:bg-accent/40';

export const capsulePhysKeyButtonClass =
  'h-[length:var(--composer-phys-key-height)] w-full font-mono text-[length:var(--composer-font-size)]';

export const capsulePhysKeyIconClass = 'size-[length:var(--composer-phys-key-icon-size)]';

export const capsulePhysKeyRowClass =
  'flex justify-between gap-[length:var(--composer-popover-gap)] border-b border-border/60 px-[length:var(--composer-phys-key-pad-x)] py-[length:var(--composer-phys-key-pad-y)]';

export const capsulePhysKeyGridGapClass = 'gap-[length:var(--composer-phys-key-grid-gap)]';

export const capsuleChainBarClass =
  'flex items-center gap-[length:var(--composer-popover-gap)] border-b border-border/60 bg-primary/10 px-[length:var(--composer-phys-key-pad-x)] py-[length:var(--composer-popover-inner-pad)] text-[length:var(--composer-font-size)]';

export const capsuleMiniButtonClass =
  'h-[length:var(--composer-mini-control-height)] text-[length:var(--composer-caption-font-size)]';

export const capsuleQuickKeyButtonClass =
  'shrink-0 font-mono text-[length:var(--composer-font-size)] min-h-[length:var(--control-md)]';

export const capsuleDropdownMinWidthClass =
  'min-w-[length:var(--composer-dropdown-min-width)]';

export const capsuleDropdownItemClass =
  'cursor-pointer font-mono text-[length:var(--composer-font-size)]';

export const capsuleDialogStackClass = 'flex flex-col gap-[length:var(--composer-dialog-gap)]';

export const capsuleChipRowClass = 'flex flex-wrap gap-[length:var(--composer-chip-gap)]';

export const capsuleChipButtonClass =
  'h-[length:var(--control-md)] px-[length:var(--composer-popover-item-pad-x)] text-[length:var(--composer-font-size)]';

export const capsuleKeyInputClass =
  'h-[length:var(--control-md)] w-[length:var(--composer-key-input-width)] text-center font-mono text-[length:var(--composer-font-size)]';

export const capsuleDialogInputClass =
  'h-[length:var(--control-md)] text-[length:var(--composer-font-size)]';

export const capsuleDialogActionRowClass =
  'flex justify-end gap-[length:var(--composer-popover-gap)]';

export const capsuleDialogMaxWidthClass = 'max-w-[length:var(--composer-dialog-max-width)]';

export const capsuleTabRowClass =
  'mb-[length:var(--composer-dialog-gap)] flex gap-[length:var(--composer-chip-gap)]';

export const capsuleTabButtonClass =
  'h-[length:var(--composer-tab-height)] px-[length:var(--composer-popover-inner-pad)] text-[length:var(--composer-font-size)]';

export const capsuleIconCloseButtonClass =
  'h-[length:var(--composer-icon-close-size)] w-[length:var(--composer-icon-close-size)] shrink-0 text-muted-foreground hover:text-destructive';

export const capsuleAddCommandFooterClass =
  'h-[length:var(--control-md)] w-full rounded-none text-[length:var(--composer-font-size)]';

export const capsuleAddCommandIconClass =
  'mr-[length:var(--composer-popover-inner-pad)] size-[length:var(--composer-phys-key-icon-size)]';

export const capsuleIconCloseSvgClass = 'size-[length:var(--composer-phys-key-icon-size)]';

export const capsuleLabelTextClass =
  'shrink-0 text-[length:var(--composer-font-size)] text-muted-foreground';

export const capsuleInlineFieldRowClass =
  'flex items-center gap-[length:var(--composer-popover-gap)]';

export const capsuleModeToggleItemClass =
  'min-h-[length:var(--control-md)] min-w-[length:var(--control-md)] [&_svg]:size-[length:var(--icon-md)]';
