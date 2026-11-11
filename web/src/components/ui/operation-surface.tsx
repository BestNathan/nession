import type { ReactNode } from 'react';

import { cn } from '@/shared/lib/utils';
import { chromeSansRole } from '@/shared/typography/chromeRoles';

/**
 * Operation Surface recipe (issue 3137).
 *
 * An operation is a deliberate, reversible depth where the user edits a draft
 * and then commits or leaves: create/settings, a policy confirmation, attach
 * configuration. The surface itself is *not* reimplemented here — Web keeps the
 * shared Dialog (`overlay-surfaces`, issue 3142), and the App keeps its one
 * `AppOperationPage` / `AppSheet` (issue 3089). This module owns the body and action
 * grammar those surfaces share, so their contents read as one operation
 * language:
 *
 * - one heading, then one quiet lead that states the consequence of the act;
 * - named sections (a `FormSection`), never a second scrolling region;
 * - one error line for an action failure, field failures stay on their fields;
 * - one action group, secondary before primary, with the primary last.
 *
 * Close/Back and the scroll owner belong to the surface primitive; a consumer
 * must not add a second one inside the body.
 */

/** A quiet statement of what this operation will do. */
export function OperationLead({ className, ...props }: React.ComponentProps<'p'>) {
  return (
    <p
      data-recipe-part="operation-lead"
      className={cn('text-muted-foreground', chromeSansRole('secondary'), className)}
      {...props}
    />
  );
}

/**
 * The operation's action line. Order children secondary → primary; this
 * component does not reorder them, because the caller often owns the DOM order
 * that a sticky dialog footer reverses arithmetically.
 */
export function OperationActions({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-recipe-part="operation-actions"
      className={cn('flex min-w-0 flex-wrap items-center gap-2', className)}
      {...props}
    />
  );
}

/** A surface-level failure. A field failure belongs on its `FormField`. */
export function OperationError({
  children,
  className,
  testId,
}: {
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <p
      role="alert"
      data-recipe-part="operation-error"
      data-testid={testId}
      className={cn(
        'rounded-[var(--nession-radius-surface)] bg-destructive/10 px-2.5 py-1.5',
        chromeSansRole('secondary'),
        'text-destructive',
        className,
      )}
    >
      {children}
    </p>
  );
}
