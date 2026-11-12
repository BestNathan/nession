import type { ReactNode } from 'react';
import { cn } from '@/shared/lib/utils';
import { chromeSansRole } from '@/shared/typography/chromeRoles';

export interface SidebarSectionHeadProps {
  /** The section's name. Sentence case; these are not eyebrow labels. */
  label: string;
  /**
   * Optional trailing control, rendered opposite the label — a count or a
   * disclosure action the caller owns.
   */
  action?: ReactNode;
}

/**
 * A sidebar section label, above the rows it names (the Web column's `Sessions`).
 *
 * Muted and smaller than the rows themselves — `visual-language.md`'s
 * typography rules put a section label below the things it labels, and
 * "metadata never outweighs the thing it describes" applies to a section name
 * as much as to a timestamp.
 */
export function SidebarSectionHead({ label, action }: SidebarSectionHeadProps) {
  return (
    <div
      className={cn(
        'flex shrink-0 items-center justify-between gap-[var(--nession-shell-space-2)] whitespace-nowrap px-[var(--nession-shell-space-2)] pt-[var(--nession-shell-space-1)] pb-[var(--nession-shell-section-head-pad-bottom)] text-muted-foreground',
        chromeSansRole('secondary'),
      )}
    >
      <span className="truncate">{label}</span>
      {action}
    </div>
  );
}
