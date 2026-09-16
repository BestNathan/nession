import type { ReactNode } from 'react';

export interface SidebarSectionHeadProps {
  /** The section's name. Sentence case; these are not eyebrow labels. */
  label: string;
  /**
   * Optional trailing control, rendered opposite the label. Both sidebar
   * sections share this row so a label never drifts out of step with the other.
   */
  action?: ReactNode;
}

/**
 * A sidebar section label, above the rows it names.
 *
 * Muted and smaller than the rows themselves — `visual-language.md`'s
 * typography rules put a section label below the things it labels, and
 * "metadata never outweighs the thing it describes" applies to a section name
 * as much as to a timestamp.
 */
export function SidebarSectionHead({ label, action }: SidebarSectionHeadProps) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-[var(--shell-space-2)] whitespace-nowrap px-[var(--shell-space-2)] pt-[var(--shell-space-1)] pb-[var(--shell-section-head-pad-bottom)] text-[length:var(--shell-section-head-font-size)] text-muted-foreground">
      <span className="truncate">{label}</span>
      {action}
    </div>
  );
}

/**
 * The inset rule between sidebar sections.
 *
 * Inset rather than edge-to-edge: the mockup draws `margin: 8px`, so it reads as
 * a division inside one column instead of a second panel edge — which matters
 * here because the column already has a surface of its own.
 */
export function SidebarSectionSeparator() {
  return (
    <div
      data-testid="sidebar-section-separator"
      role="separator"
      className="mx-[var(--shell-section-sep-margin)] my-[var(--shell-section-sep-margin)] h-px shrink-0 bg-border"
    />
  );
}
