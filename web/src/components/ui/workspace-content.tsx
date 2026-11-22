import * as React from 'react';

import { cn } from '@/shared/lib/utils';
import { chromeSansRole } from '@/shared/typography/chromeRoles';

/**
 * Semantic Workspace content roles (issue 3971).
 *
 * The App's Workspace is one canvas owned by the Experience host. Inside it, a
 * capability picks from this small vocabulary instead of laying rows directly
 * on the canvas or inventing its own card:
 *
 * ```text
 * WorkspaceSurface (primary | secondary)
 *   WorkspaceSectionStack
 *     WorkspaceSection        (name + optional description/action)
 *       WorkspaceGroup        (contiguous rows, one separator language)
 *         WorkspaceRow        (slot + title/subtitle + trailing action)
 * ```
 *
 * Ownership: spacing, surface contrast and row geometry are Nession's; which
 * role a region takes, and what it contains, belongs to the capability. There
 * is deliberately no universal layout DSL — a Reader can use a bare
 * `WorkspaceSurface`, a Collection composes Groups of Rows, and a
 * Configuration keeps using `ConfigurationForm` inside a Section.
 *
 * Rules encoded here:
 * - a row is not a card; one continuous group shares one separator language;
 * - an icon slot (`control.visualSize`) is distinct from the 44px touch target
 *   a surrounding button owns;
 * - every relationship consumes an existing `--nession-rhythm-*` role, never a
 *   local offset.
 */
export type WorkspaceSurfaceLevel = 'primary' | 'secondary';

export function WorkspaceSurface({
  level = 'primary',
  className,
  children,
  testId,
}: {
  level?: WorkspaceSurfaceLevel;
  className?: string;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <div
      data-workspace-surface={level}
      data-testid={testId}
      className={cn(
        'flex min-w-0 flex-col',
        level === 'primary' ? 'bg-card' : 'bg-muted/40',
        className,
      )}
    >
      {children}
    </div>
  );
}

/** The vertical stacking owner between sibling Sections. */
export function WorkspaceSectionStack({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      data-workspace-section-stack=""
      className={cn(
        'flex min-w-0 flex-col gap-[var(--nession-rhythm-section-stack)]',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function WorkspaceSection({
  title,
  description,
  action,
  level = 'h3',
  className,
  testId,
  children,
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  /** A section-level action, e.g. "Browse all". */
  action?: React.ReactNode;
  level?: 'h2' | 'h3';
  className?: string;
  testId?: string;
  children: React.ReactNode;
}) {
  const Heading = level;
  return (
    <section
      data-workspace-section=""
      data-testid={testId}
      className={cn(
        'flex min-w-0 flex-col gap-[var(--nession-rhythm-section-content)]',
        className,
      )}
    >
      {title || action ? (
        <div className="flex min-w-0 items-center justify-between gap-[var(--nession-rhythm-inline)]">
          {title ? (
            <Heading
              data-workspace-section-title=""
              className={cn('min-w-0 text-muted-foreground', chromeSansRole('secondary'))}
            >
              {title}
            </Heading>
          ) : (
            <span />
          )}
          {action}
        </div>
      ) : null}
      {description ? (
        <p className={cn('text-muted-foreground', chromeSansRole('caption'))}>{description}</p>
      ) : null}
      {children}
    </section>
  );
}

/**
 * One continuous run of sibling rows.
 *
 * Siblings share a hairline separator and no outer gap; the rhythm between two
 * Groups is the Section's job. That is what keeps a collection from becoming a
 * stack of cards.
 */
export function WorkspaceGroup({
  className,
  testId,
  children,
}: {
  className?: string;
  testId?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      data-workspace-group=""
      data-testid={testId}
      className={cn(
        'flex min-w-0 flex-col divide-y divide-border overflow-hidden rounded-[var(--nession-radius-surface)]',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function WorkspaceRow({
  leading,
  title,
  subtitle,
  trailing,
  onActivate,
  selected,
  className,
  testId,
  titleTestId,
}: {
  /** A leading glyph inside the canonical slot; never a bare floating icon. */
  leading?: React.ReactNode;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  /** A trailing action. It owns its own 44px target on App. */
  trailing?: React.ReactNode;
  onActivate?: () => void;
  selected?: boolean;
  className?: string;
  testId?: string;
  titleTestId?: string;
}) {
  const content = (
    <>
      {leading ? (
        <span
          data-workspace-row-slot=""
          className="grid size-[length:var(--nession-control-visual-size)] shrink-0 place-items-center rounded-[var(--nession-radius-control)] bg-muted text-muted-foreground"
        >
          {leading}
        </span>
      ) : null}
      <span className="flex min-w-0 flex-1 flex-col gap-[var(--nession-rhythm-text-stack)]">
        <span
          data-workspace-row-title=""
          data-testid={titleTestId}
          className={cn('truncate', chromeSansRole('primary'))}
        >
          {title}
        </span>
        {subtitle ? (
          <span className={cn('truncate text-muted-foreground', chromeSansRole('caption'))}>
            {subtitle}
          </span>
        ) : null}
      </span>
      {trailing ? <span className="flex shrink-0 items-center">{trailing}</span> : null}
    </>
  );

  const shared = cn(
    'flex min-h-[length:var(--nession-control-md)] w-full min-w-0 items-center gap-[var(--nession-rhythm-inline)] px-[var(--nession-shell-space-3)] py-[var(--nession-shell-space-1)] text-left',
    selected && 'bg-accent text-accent-foreground',
    className,
  );

  if (onActivate === undefined) {
    return (
      <div data-workspace-row="" data-testid={testId} className={shared}>
        {content}
      </div>
    );
  }
  return (
    <button
      type="button"
      data-workspace-row=""
      data-testid={testId}
      aria-current={selected ? 'true' : undefined}
      onClick={() => onActivate()}
      className={cn(
        shared,
        'transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-solid focus-visible:outline-[length:var(--nession-focus-ring-width)] focus-visible:outline-ring focus-visible:outline-offset-[calc(-1*var(--nession-focus-ring-offset))]',
      )}
    >
      {content}
    </button>
  );
}
