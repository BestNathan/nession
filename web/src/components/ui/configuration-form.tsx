import * as React from 'react';

import { cn } from '@/shared/lib/utils';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
import { Label } from './label';
import { formRowClass } from './configuration-formStyles';

/**
 * Configuration Form recipe (issue 3137).
 *
 * One grammar for every editable resource configuration: named sections, a
 * field label + control + help + error in that order, paired fields when the
 * contents genuinely support a row, repeated dynamic rows, and a grouped
 * action line. The domain keeps its own data owner and validation; this recipe
 * owns only the presentation relationships, so Project settings and a Sandbox
 * policy editor cannot drift into two different form consciences.
 *
 * Web may place two related fields side by side; an App composition passes a
 * stacked layout, and the fields stay full-width and touch-sized. That is an
 * explicit composition variant, not a consumer-local class fork.
 *
 * First-view simplification belongs to the consumer: an optional group keeps
 * its section but must not look as important as required identity. This recipe
 * gives a section one quiet heading and one description slot for that purpose.
 */
export type FormHeadingLevel = 'h2' | 'h3';

export function FormSurface({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-recipe="configuration-form"
      data-recipe-part="form-surface"
      className={cn('flex w-full min-w-0 flex-col gap-5', className)}
      {...props}
    />
  );
}

export function FormSection({
  title,
  description,
  action,
  children,
  level = 'h3',
  titleId,
  descriptionId,
  className,
  testId,
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  /** A section-level action, e.g. Add Location. */
  action?: React.ReactNode;
  children: React.ReactNode;
  level?: FormHeadingLevel;
  titleId?: string;
  descriptionId?: string;
  className?: string;
  testId?: string;
}) {
  const Heading = level;
  return (
    <section
      data-recipe-part="form-section"
      data-testid={testId}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      className={cn('flex min-w-0 flex-col gap-3', className)}
    >
      {title || action ? (
        <div className="flex min-w-0 items-center justify-between gap-2">
          {title ? (
            <Heading
              id={titleId}
              data-recipe-part="form-section-title"
              className={cn('min-w-0', chromeSansRole('secondary'))}
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
        <p
          id={descriptionId}
          data-recipe-part="form-section-description"
          className={cn('text-muted-foreground', chromeSansRole('caption'))}
        >
          {description}
        </p>
      ) : null}
      {children}
    </section>
  );
}

export function FormField({
  id,
  label,
  description,
  error,
  labelAction,
  children,
  className,
  testId,
  labelTestId,
  descriptionTestId,
  errorTestId,
}: {
  /** The control's id, when the label can own the association. */
  id?: string;
  label: React.ReactNode;
  /** Supporting copy under the control. */
  description?: React.ReactNode;
  /** The field's own validation failure, not a surface-level action error. */
  error?: React.ReactNode;
  /** A label-row companion, e.g. a character count. */
  labelAction?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  testId?: string;
  labelTestId?: string;
  descriptionTestId?: string;
  errorTestId?: string;
}) {
  return (
    <div
      data-recipe-part="form-field"
      data-testid={testId}
      className={cn('flex min-w-0 flex-col gap-1.5', className)}
    >
      <div className="flex min-w-0 items-center justify-between gap-2">
        <Label
          htmlFor={id}
          data-recipe-part="form-label"
          data-testid={labelTestId}
          className="min-w-0"
        >
          {label}
        </Label>
        {labelAction}
      </div>
      {children}
      {description ? (
        <p
          data-recipe-part="form-help"
          data-testid={descriptionTestId}
          className={cn('text-muted-foreground', chromeSansRole('caption'))}
        >
          {description}
        </p>
      ) : null}
      {error ? (
        <p
          role="alert"
          data-recipe-part="form-error"
          data-testid={errorTestId}
          className={cn('text-destructive', chromeSansRole('caption'))}
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Two related fields on Web; one stacked column when the composition is App. */
export function FormGrid({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-recipe-part="form-grid"
      className={cn('grid min-w-0 grid-cols-1 gap-3 lg:grid-cols-2', className)}
      {...props}
    />
  );
}

/** A repeated editable unit: location, native Key/Value entry. */
export function FormRow({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-recipe-part="form-row"
      className={cn(formRowClass, className)}
      {...props}
    />
  );
}

/** A grouped local action line. Secondary actions precede the primary one. */
export function FormActions({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-recipe-part="form-actions"
      className={cn('flex min-w-0 flex-wrap items-center gap-2', className)}
      {...props}
    />
  );
}
