import { RefreshCw } from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
import type { HostPullPhase } from './useHostPullRefresh';

/**
 * The host-owned pull indicator (#4602 §4).
 *
 * The host renders it above the list and owns its travel, release and settling.
 * A capability never draws its own indicator or a second scroll container. It
 * is aria-hidden: the accessible path is the visible header Refresh action, and
 * the gesture is only an accelerator.
 */
export function HostPullIndicator({
  distance,
  phase,
}: {
  distance: number;
  phase: HostPullPhase;
}) {
  const visible = distance > 4 || phase === 'busy';
  const label = phase === 'busy'
    ? 'Refreshing…'
    : phase === 'ready' ? 'Release to refresh' : 'Pull to refresh';
  return (
    <div
      data-testid="app-pull-indicator"
      data-phase={phase}
      aria-hidden="true"
      className="pointer-events-none flex shrink-0 items-end justify-center overflow-hidden"
      style={{ height: phase === 'busy' ? 34 : distance }}
    >
      <span
        className={cn(
          'flex items-center gap-[var(--nession-shell-space-2)] pb-[var(--nession-shell-space-2)] text-muted-foreground',
          visible ? 'opacity-100' : 'opacity-0',
        )}
      >
        <RefreshCw
          className={cn('size-[length:var(--nession-icon-sm)]', phase === 'busy' && 'animate-spin')}
        />
        <span className={chromeSansRole('caption')}>{label}</span>
      </span>
    </div>
  );
}
