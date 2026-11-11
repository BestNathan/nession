import * as React from 'react';

import { cn } from '@/shared/lib/utils';
import { chromeLabelRole, chromeMonoRole, chromeSansRole } from '@/shared/typography/chromeRoles';

/**
 * Resource / Capability Detail recipe (issue 3137).
 *
 * One quiet, whitespace-first grammar for a destination that names a resource
 * (a Project) or a capability's observed state (a Sandbox's effective policy):
 * identity, quiet scope, observed facts, grouped resources, local actions and
 * recovery. It is deliberately not a page component — the host keeps its own
 * shell, navigation and scroll ownership; this recipe owns only what the
 * content region says and how its internal hierarchy reads.
 *
 * Every consumer emits the same `data-recipe-part` names so an executable
 * check can compare corresponding roles between two independent surfaces
 * instead of trusting that each one used an allowed token in isolation.
 *
 * Rules:
 * - a fact is a label/value pair, never an input-shaped box; read-only state
 *   must not look editable;
 * - a section is separated by rhythm, not by stacking border + background +
 *   radius around every group;
 * - the surface name is the `title` typography role, a section heading is
 *   `secondary`, and a fact label is a quiet `caption`;
 * - a resource row is a plain row at rest; only an interactive row gains a
 *   background shift, on hover/focus.
 */
export type DetailHeadingLevel = 'h1' | 'h2' | 'h3';

export function DetailSurface({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-recipe="resource-detail"
      data-recipe-part="detail-surface"
      className={cn('flex w-full min-w-0 flex-col gap-5', className)}
      {...props}
    />
  );
}

export function DetailHeader({
  eyebrow,
  title,
  badges,
  meta,
  description,
  actions,
  children,
  titleId,
  titleTestId,
  level = 'h2',
  className,
  testId,
}: {
  /** Quiet scope above the surface name, e.g. the resource kind. */
  eyebrow?: React.ReactNode;
  /** The surface's own name. Omit when the host already names it. */
  title?: React.ReactNode;
  /** Status/identity chips that belong to the name. */
  badges?: React.ReactNode;
  /** Technical or supporting identity that belongs under the name. */
  meta?: React.ReactNode;
  /** One quiet sentence describing the scope of this surface. */
  description?: React.ReactNode;
  /** Top-right local actions, e.g. a settings icon. */
  actions?: React.ReactNode;
  /** A local action row under the identity. */
  children?: React.ReactNode;
  titleId?: string;
  titleTestId?: string;
  level?: DetailHeadingLevel;
  className?: string;
  testId?: string;
}) {
  const Heading = level;
  return (
    <header
      data-recipe-part="detail-header"
      data-testid={testId}
      className={cn('flex min-w-0 flex-col gap-2', className)}
    >
      {eyebrow ? (
        <p
          data-recipe-part="detail-eyebrow"
          className={cn('text-muted-foreground', chromeLabelRole('caption'))}
        >
          {eyebrow}
        </p>
      ) : null}
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {title !== undefined ? (
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <Heading
                id={titleId}
                data-recipe-part="detail-title"
                data-testid={titleTestId}
                className={cn('min-w-0', chromeSansRole('title'))}
              >
                {title}
              </Heading>
              {badges}
            </div>
          ) : badges ? (
            <div className="flex min-w-0 flex-wrap items-center gap-2">{badges}</div>
          ) : null}
          {meta ? (
            <p
              data-recipe-part="detail-meta"
              className="min-w-0 break-all text-muted-foreground"
            >
              {meta}
            </p>
          ) : null}
          {description ? (
            <p
              data-recipe-part="detail-description"
              className={cn('min-w-0 text-muted-foreground', chromeSansRole('secondary'))}
            >
              {description}
            </p>
          ) : null}
        </div>
        {actions ? (
          <div data-recipe-part="detail-actions" className="flex shrink-0 items-center gap-1">
            {actions}
          </div>
        ) : null}
      </div>
      {children ? (
        <div
          data-recipe-part="detail-header-actions"
          className="flex min-w-0 flex-wrap items-center gap-2"
        >
          {children}
        </div>
      ) : null}
    </header>
  );
}

export function DetailSection({
  title,
  action,
  children,
  level = 'h2',
  titleId,
  className,
  testId,
}: {
  title: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  level?: DetailHeadingLevel;
  titleId?: string;
  className?: string;
  testId?: string;
}) {
  const Heading = level;
  return (
    <section
      data-recipe-part="detail-section"
      data-testid={testId}
      className={cn('flex min-w-0 flex-col gap-2', className)}
    >
      <div className="flex min-w-0 items-center justify-between gap-2">
        <Heading
          id={titleId}
          data-recipe-part="detail-section-title"
          className={cn('min-w-0', chromeSansRole('secondary'))}
        >
          {title}
        </Heading>
        {action}
      </div>
      {children}
    </section>
  );
}

/** A vertical group of resource rows or facts with one rhythm between them. */
export function DetailGroup({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-recipe-part="detail-group"
      className={cn('flex min-w-0 flex-col gap-1', className)}
      {...props}
    />
  );
}

export function DetailFacts({ className, ...props }: React.ComponentProps<'dl'>) {
  return (
    <dl
      data-recipe-part="detail-facts"
      className={cn('flex min-w-0 flex-col gap-3', className)}
      {...props}
    />
  );
}

export function DetailFact({
  label,
  mono = false,
  inline = false,
  children,
  className,
  labelClassName,
  valueClassName,
  testId,
  labelTestId,
  valueTestId,
}: {
  label: React.ReactNode;
  /** Technical value: paths, digests, ids. The role still owns its size. */
  mono?: boolean;
  /** Label and value share one line (a compact scalar fact). */
  inline?: boolean;
  children: React.ReactNode;
  className?: string;
  labelClassName?: string;
  valueClassName?: string;
  testId?: string;
  labelTestId?: string;
  valueTestId?: string;
}) {
  return (
    <div
      data-recipe-part="detail-fact"
      data-testid={testId}
      className={cn(
        'min-w-0',
        inline ? 'flex items-baseline gap-2' : 'flex flex-col gap-0.5',
        className,
      )}
    >
      <dt
        data-recipe-part="detail-fact-label"
        data-testid={labelTestId}
        className={cn(
          'text-muted-foreground',
          chromeSansRole('caption'),
          inline && 'shrink-0',
          labelClassName,
        )}
      >
        {label}
      </dt>
      <dd
        data-recipe-part="detail-fact-value"
        data-testid={valueTestId}
        className={cn(
          'min-w-0 break-all',
          mono ? chromeMonoRole('code') : chromeSansRole('body'),
          valueClassName,
        )}
      >
        {children}
      </dd>
    </div>
  );
}

/** A quiet description of an absence or an optional fact group. */
export function DetailEmpty({ className, ...props }: React.ComponentProps<'p'>) {
  return (
    <p
      data-recipe-part="detail-empty"
      className={cn('text-muted-foreground', chromeSansRole('secondary'), className)}
      {...props}
    />
  );
}

/** Supporting explanation that must not compete with the fact it describes. */
export function DetailNote({ className, ...props }: React.ComponentProps<'p'>) {
  return (
    <p
      data-recipe-part="detail-note"
      className={cn('text-muted-foreground', chromeSansRole('caption'), className)}
      {...props}
    />
  );
}
