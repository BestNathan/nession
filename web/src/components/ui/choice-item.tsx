import type { ReactNode } from 'react';

import { cn } from '@/shared/lib/utils';
import { chromeMonoRole, chromeSansRole } from '@/shared/typography/chromeRoles';

/**
 * The resource/rich-choice content slots (issue 3164).
 *
 * The row surface lives in `choice-itemStyles.ts`; this component owns the slot
 * grammar inside it. The Consumer supplies the resource's meaning: a primary
 * title, optional status, optional source/type and an optional technical
 * detail. Use it only inside a row with `anatomy="resource"`.
 */
export type ChoiceItemStatusTone = 'neutral' | 'unavailable';

export function ChoiceItemContent({
  leading,
  title,
  meta,
  detail,
  status,
  statusTone = 'neutral',
  detailTestId,
  statusTestId,
}: {
  leading?: ReactNode;
  title: ReactNode;
  /** Quiet secondary line for source/type. */
  meta?: ReactNode;
  /** Technical value (path/address); rendered in the mono role and wraps anywhere. */
  detail?: ReactNode;
  status?: ReactNode;
  statusTone?: ChoiceItemStatusTone;
  detailTestId?: string;
  statusTestId?: string;
}) {
  return (
    <span
      data-slot="choice-item-content"
      className="flex min-w-0 flex-1 items-start gap-2.5 text-left"
    >
      {leading ? (
        <span
          aria-hidden
          data-slot="choice-item-leading"
          className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-[var(--nession-radius-control)] border border-border/60 bg-background text-muted-foreground"
        >
          {leading}
        </span>
      ) : null}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span
            data-slot="choice-item-title"
            className={cn('min-w-0 break-words', chromeSansRole('body'))}
          >
            {title}
          </span>
          {' '}
          {status ? (
            <span
              data-slot="choice-item-status"
              data-testid={statusTestId}
              className={cn(
                'shrink-0',
                chromeSansRole('caption'),
                statusTone === 'unavailable'
                  ? 'text-destructive'
                  : 'text-muted-foreground',
              )}
            >
              {status}
            </span>
          ) : null}
        </span>
        {meta ? (
          <span
            data-slot="choice-item-meta"
            className={cn(
              'min-w-0 break-words text-muted-foreground',
              chromeSansRole('metadata'),
            )}
          >
            {meta}
          </span>
        ) : null}
        {detail ? (
          <span
            data-slot="choice-item-detail"
            data-testid={detailTestId}
            className={cn(
              'min-w-0 break-all text-muted-foreground',
              chromeMonoRole('caption'),
            )}
          >
            {detail}
          </span>
        ) : null}
      </span>
    </span>
  );
}
