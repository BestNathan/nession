import { ArrowLeft, ArrowRight } from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import { chromeLabelRole } from '@/shared/typography/chromeRoles';

export interface SwipeDestinationPreviewProps {
  name: string | null;
  direction: -1 | 0 | 1;
}

/**
 * The one piece of chrome a live App swipe adds (#2724).
 *
 * It exists only after the shell has claimed a horizontal drag and disappears
 * on release. It is pointer-transparent, carries no resting state, and is
 * hidden from assistive technology because the visible header controls — not
 * the gesture — are the accessible route.
 */
export function SwipeDestinationPreview({ name, direction }: SwipeDestinationPreviewProps) {
  if (name === null) {
    return null;
  }

  const right = direction > 0;
  const Arrow = right ? ArrowRight : ArrowLeft;

  return (
    <div
      aria-hidden="true"
      data-testid="app-swipe-preview"
      data-destination={name.toLowerCase()}
      data-direction={right ? 'right' : 'left'}
      className={cn(
        'pointer-events-none absolute left-1/2 z-50 flex -translate-x-1/2 items-center gap-1.5',
        'rounded-[var(--nession-radius-control)] border border-border/70',
        'bg-popover/90 px-3 py-1.5 text-popover-foreground backdrop-blur-sm',
        'shadow-[var(--nession-elevation-floating)]',
        chromeLabelRole('metadata'),
      )}
      style={{ top: 'calc(env(safe-area-inset-top, 0px) + 3.75rem)' }}
    >
      <Arrow className="size-3.5" strokeWidth={2.25} />
      <span>{name}</span>
    </div>
  );
}
